/**
 * Performance monitoring service for typeahead metrics.
 * Tracks latency, interaction timing, and cache effectiveness as this browser tab sees them.
 *
 * The search store records into it (stores/search-store.ts) and the home page's
 * PerformancePanel reads it. Everything stays in memory for the current tab.
 */

export interface TypeaheadMetrics {
  // Lookups: searches whose result was shown. A cache hit was answered by this tab's memory
  // cache without a request.
  lookups: number;
  cacheHits: number;
  cacheHitRate: number;

  // Network: requests actually sent (including ones superseded before they returned), and the
  // latency of the responses that were shown (request start to parsed response)
  requestsSent: number;
  networkResponses: number;
  avgLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;

  // Interaction metrics
  avgKeyToSuggestionMs: number; // keystroke -> first paint of the suggestions for that keystroke
  keyToSuggestionSamples: number;
  avgSelectionTimeMs: number; // last keystroke -> suggestion picked from the typed list
  selectionTimeSamples: number;
  selectionsCount: number; // every selection, including trending and recent-search picks

  // Error metrics: failed requests (aborted or superseded requests are not errors)
  errorCount: number;
  errorRate: number;
}

const MAX_SAMPLES = 1000;

const pushBounded = (samples: number[], sample: number): void => {
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
  private networkLatencies: number[] = [];
  private keyToSuggestionSamples: number[] = [];
  private selectionSamples: number[] = [];
  private lookups = 0;
  private cacheHits = 0;
  private requestsSent = 0;
  private selectionsCount = 0;
  private errorCount = 0;
  // performance.now() of the latest keystroke, until its suggestions are shown (or it fails)
  private lastKeyPress: number | null = null;
  // performance.now() of the latest keystroke of a typed interaction, until a pick ends it
  private interactionStart: number | null = null;

  /**
   * Record a keystroke that changed the query to a non-empty value. Returns its timestamp, which
   * the caller passes back to recordSuggestionsDisplayed for the search it triggers.
   */
  recordKeyPress(): number {
    const now = performance.now();
    this.lastKeyPress = now;
    this.interactionStart = now;
    return now;
  }

  /**
   * The input was cleared: the typed interaction is over without a pick.
   */
  recordInputCleared(): void {
    this.lastKeyPress = null;
    this.interactionStart = null;
  }

  /**
   * Record a search whose result was shown. durationMs is the lookup itself (memory cache or
   * network), not the render; only network answers count toward the latency percentiles.
   */
  recordLookup(durationMs: number, fromTabCache: boolean): void {
    this.lookups++;
    if (fromTabCache) {
      this.cacheHits++;
    } else {
      pushBounded(this.networkLatencies, durationMs);
    }
  }

  /**
   * Record that a suggestion request went to the network.
   */
  recordRequestSent(): void {
    this.requestsSent++;
  }

  /**
   * Record that suggestions answering the keystroke at keyAt were painted. Ignored when a newer
   * keystroke has happened since (its own answer will be measured) or keyAt was already answered.
   */
  recordSuggestionsDisplayed(keyAt: number): void {
    if (this.lastKeyPress === null || keyAt !== this.lastKeyPress) return;
    pushBounded(this.keyToSuggestionSamples, performance.now() - keyAt);
    this.lastKeyPress = null;
  }

  /**
   * Record a selection. Only a pick from the list for the typed query (fromTypedList) ends a
   * typed interaction and yields a keystroke-to-selection sample.
   */
  recordSelection(fromTypedList: boolean): void {
    this.selectionsCount++;
    if (fromTypedList && this.interactionStart !== null) {
      pushBounded(this.selectionSamples, performance.now() - this.interactionStart);
    }
    this.interactionStart = null;
    this.lastKeyPress = null;
  }

  /**
   * Record a failed suggestion request. Its keystroke is answered (by an error), so a later
   * success that wasn't caused by a keystroke doesn't measure from it.
   */
  recordError(): void {
    this.errorCount++;
    this.lastKeyPress = null;
  }

  /**
   * Get comprehensive metrics.
   */
  getMetrics(): TypeaheadMetrics {
    const latencies = [...this.networkLatencies].sort((a, b) => a - b);
    const attempts = latencies.length + this.errorCount;

    return {
      lookups: this.lookups,
      cacheHits: this.cacheHits,
      cacheHitRate: this.lookups > 0 ? this.cacheHits / this.lookups : 0,

      requestsSent: this.requestsSent,
      networkResponses: latencies.length,
      avgLatencyMs: average(latencies),
      p50LatencyMs: percentile(latencies, 50),
      p95LatencyMs: percentile(latencies, 95),
      p99LatencyMs: percentile(latencies, 99),

      avgKeyToSuggestionMs: average(this.keyToSuggestionSamples),
      keyToSuggestionSamples: this.keyToSuggestionSamples.length,
      avgSelectionTimeMs: average(this.selectionSamples),
      selectionTimeSamples: this.selectionSamples.length,
      selectionsCount: this.selectionsCount,

      errorCount: this.errorCount,
      errorRate: attempts > 0 ? this.errorCount / attempts : 0,
    };
  }

  /**
   * Clear all metrics.
   */
  reset(): void {
    this.networkLatencies = [];
    this.keyToSuggestionSamples = [];
    this.selectionSamples = [];
    this.lookups = 0;
    this.cacheHits = 0;
    this.requestsSent = 0;
    this.selectionsCount = 0;
    this.errorCount = 0;
    this.lastKeyPress = null;
    this.interactionStart = null;
  }
}

// Singleton instance
export const performanceMonitor = new PerformanceMonitor();

// Convenience functions
export const recordKeyPress = performanceMonitor.recordKeyPress.bind(performanceMonitor);
export const recordInputCleared = performanceMonitor.recordInputCleared.bind(performanceMonitor);
export const recordLookup = performanceMonitor.recordLookup.bind(performanceMonitor);
export const recordRequestSent = performanceMonitor.recordRequestSent.bind(performanceMonitor);
export const recordSuggestionsDisplayed =
  performanceMonitor.recordSuggestionsDisplayed.bind(performanceMonitor);
export const recordSelection = performanceMonitor.recordSelection.bind(performanceMonitor);
export const recordError = performanceMonitor.recordError.bind(performanceMonitor);
export const getMetrics = performanceMonitor.getMetrics.bind(performanceMonitor);
export const resetMetrics = performanceMonitor.reset.bind(performanceMonitor);
