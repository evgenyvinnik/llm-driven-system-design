/**
 * Performance monitoring service for typeahead metrics.
 * Tracks latency, interaction timing, and cache effectiveness as this browser tab sees them.
 *
 * The search store records into it (stores/search-store.ts) and the home page's
 * PerformancePanel reads it. Everything stays in memory for the current tab.
 */

export interface TypeaheadMetrics {
  // Latency metrics (request start to response, as seen by the client)
  avgLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;

  // Request metrics. A cache hit is a response served from this tab's memory cache (no request)
  totalRequests: number;
  cacheHits: number;
  cacheMisses: number;
  cacheHitRate: number;

  // Interaction metrics
  avgKeyToSuggestionMs: number; // last keystroke -> suggestions rendered
  avgSelectionTimeMs: number; // last keystroke -> suggestion selected
  selectionsCount: number;

  // Error metrics
  errorCount: number;
  errorRate: number;
}

interface LatencySample {
  timestamp: number;
  durationMs: number;
  cached: boolean;
}

const MAX_SAMPLES = 1000;

const pushBounded = <T>(samples: T[], sample: T): void => {
  samples.push(sample);
  if (samples.length > MAX_SAMPLES) samples.splice(0, samples.length - MAX_SAMPLES);
};

const average = (values: number[]): number =>
  values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;

const percentile = (sorted: number[], p: number): number => {
  if (sorted.length === 0) return 0;
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, index)];
};

class PerformanceMonitor {
  private latencySamples: LatencySample[] = [];
  private keyToSuggestionSamples: number[] = [];
  private selectionSamples: number[] = [];
  private errorCount = 0;
  // performance.now() of the last keystroke that has not been answered by a render yet
  private lastKeyPress: number | null = null;
  // performance.now() of the last keystroke, kept until a selection ends the interaction
  private interactionStart: number | null = null;

  /**
   * Record a suggestion request latency.
   */
  recordLatency(durationMs: number, cached: boolean = false): void {
    pushBounded(this.latencySamples, { timestamp: Date.now(), durationMs, cached });
  }

  /**
   * Record a keystroke in the search input.
   */
  recordKeyPress(): void {
    const now = performance.now();
    this.lastKeyPress = now;
    this.interactionStart = now;
  }

  /**
   * Record that suggestions for the latest keystroke were rendered.
   * Only the first render after a keystroke counts, so a refresh doesn't add a sample.
   */
  recordSuggestionsDisplayed(): void {
    if (this.lastKeyPress === null) return;
    pushBounded(this.keyToSuggestionSamples, performance.now() - this.lastKeyPress);
    this.lastKeyPress = null;
  }

  /**
   * Record that the user selected a suggestion, ending the interaction.
   */
  recordSelection(): void {
    if (this.interactionStart === null) return;
    pushBounded(this.selectionSamples, performance.now() - this.interactionStart);
    this.interactionStart = null;
    this.lastKeyPress = null;
  }

  /**
   * Record a failed suggestion request (aborted, superseded requests are not errors).
   */
  recordError(): void {
    this.errorCount++;
  }

  /**
   * Get comprehensive metrics.
   */
  getMetrics(): TypeaheadMetrics {
    const latencies = this.latencySamples.map((s) => s.durationMs).sort((a, b) => a - b);
    const cacheHits = this.latencySamples.filter((s) => s.cached).length;
    const totalRequests = this.latencySamples.length;
    // Failed requests never produce a latency sample, so they count toward the total here
    const attempts = totalRequests + this.errorCount;

    return {
      avgLatencyMs: average(latencies),
      p50LatencyMs: percentile(latencies, 50),
      p95LatencyMs: percentile(latencies, 95),
      p99LatencyMs: percentile(latencies, 99),

      totalRequests,
      cacheHits,
      cacheMisses: totalRequests - cacheHits,
      cacheHitRate: totalRequests > 0 ? cacheHits / totalRequests : 0,

      avgKeyToSuggestionMs: average(this.keyToSuggestionSamples),
      avgSelectionTimeMs: average(this.selectionSamples),
      selectionsCount: this.selectionSamples.length,

      errorCount: this.errorCount,
      errorRate: attempts > 0 ? this.errorCount / attempts : 0,
    };
  }

  /**
   * Clear all metrics.
   */
  reset(): void {
    this.latencySamples = [];
    this.keyToSuggestionSamples = [];
    this.selectionSamples = [];
    this.errorCount = 0;
    this.lastKeyPress = null;
    this.interactionStart = null;
  }
}

// Singleton instance
export const performanceMonitor = new PerformanceMonitor();

// Convenience functions
export const recordLatency = performanceMonitor.recordLatency.bind(performanceMonitor);
export const recordKeyPress = performanceMonitor.recordKeyPress.bind(performanceMonitor);
export const recordSuggestionsDisplayed =
  performanceMonitor.recordSuggestionsDisplayed.bind(performanceMonitor);
export const recordSelection = performanceMonitor.recordSelection.bind(performanceMonitor);
export const recordError = performanceMonitor.recordError.bind(performanceMonitor);
export const getMetrics = performanceMonitor.getMetrics.bind(performanceMonitor);
export const resetMetrics = performanceMonitor.reset.bind(performanceMonitor);
