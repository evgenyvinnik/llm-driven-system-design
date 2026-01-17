/**
 * @fileoverview TypeScript type definitions for the web crawler frontend.
 *
 * This module defines the data structures used throughout the frontend:
 * - CrawlStats: Dashboard metrics from /api/stats
 * - FrontierUrl: URL entries in the crawl queue
 * - CrawledPage: Crawled page records
 * - Domain: Domain-level statistics
 *
 * These types mirror the backend API responses and ensure type safety
 * when consuming data from the crawler backend.
 *
 * @module types
 */

/**
 * Comprehensive crawler statistics for the dashboard.
 * Combines real-time Redis counters with PostgreSQL aggregations.
 */
export interface CrawlStats {
  /** Total pages successfully crawled across all workers */
  pagesCrawled: number;
  /** Total pages that failed to crawl */
  pagesFailed: number;
  /** Total bytes of content downloaded */
  bytesDownloaded: number;
  /** Total new URLs discovered from crawled pages */
  linksDiscovered: number;
  /** Number of duplicate URLs skipped */
  duplicatesSkipped: number;

  /** URLs waiting to be crawled */
  frontierPending: number;
  /** URLs currently being processed by workers */
  frontierInProgress: number;
  /** URLs successfully completed */
  frontierCompleted: number;
  /** URLs that failed */
  frontierFailed: number;
  /** Total unique domains in the frontier */
  totalDomains: number;

  /** List of active worker IDs */
  activeWorkers: string[];
  /** Worker heartbeat timestamps for health monitoring */
  workerHeartbeats: WorkerHeartbeat[];

  /** Most recently crawled pages */
  recentPages: RecentPage[];
  /** Top domains by page count */
  topDomains: DomainStats[];
}

/**
 * Worker heartbeat data for health monitoring.
 */
export interface WorkerHeartbeat {
  /** Unique worker identifier */
  workerId: string;
  /** Unix timestamp of last heartbeat */
  lastHeartbeat: number;
}

/**
 * Summary of a recently crawled page for the dashboard.
 */
export interface RecentPage {
  /** The URL that was crawled */
  url: string;
  /** Domain of the URL */
  domain: string;
  /** Extracted page title */
  title: string;
  /** HTTP status code */
  statusCode: number;
  /** ISO timestamp when crawled */
  crawledAt: string;
  /** Crawl duration in milliseconds */
  durationMs: number;
}

/**
 * Statistics for a single domain (used in top domains list).
 */
export interface DomainStats {
  /** Domain hostname */
  domain: string;
  /** Number of pages crawled from this domain */
  pageCount: number;
  /** Crawl delay in seconds */
  crawlDelay: number;
}

/**
 * URL entry in the crawler's frontier queue.
 * Represents a URL scheduled for crawling with its metadata.
 */
export interface FrontierUrl {
  /** Unique database ID */
  id: number;
  /** The URL to be crawled */
  url: string;
  /** SHA-256 hash of the normalized URL */
  urlHash: string;
  /** Domain hostname extracted from the URL */
  domain: string;
  /** Priority level: 3 (high), 2 (medium), 1 (low) */
  priority: number;
  /** Depth from seed URL (0 = seed, 1 = one hop, etc.) */
  depth: number;
  /** Current status: pending, in_progress, completed, failed */
  status: string;
  /** ISO timestamp when this URL was scheduled */
  scheduledAt: string;
}

/**
 * Crawled page record from the database.
 * Contains all extracted metadata from a successfully crawled URL.
 */
export interface CrawledPage {
  /** Unique database ID */
  id: number;
  /** The crawled URL */
  url: string;
  /** Domain hostname */
  domain: string;
  /** Extracted page title */
  title: string;
  /** Extracted meta description */
  description: string;
  /** HTTP status code returned */
  statusCode: number;
  /** Content-Type header value */
  contentType: string;
  /** Size of the content in bytes */
  contentLength: number;
  /** Number of links extracted from the page */
  linksCount: number;
  /** ISO timestamp when the page was crawled */
  crawledAt: string;
  /** Time taken to crawl in milliseconds */
  crawlDurationMs: number;
}

/**
 * Domain record with crawling statistics.
 * Aggregates crawl activity at the domain level.
 */
export interface Domain {
  /** Domain hostname (e.g., 'example.com') */
  domain: string;
  /** Number of pages crawled from this domain */
  pageCount: number;
  /** Crawl delay in seconds (from robots.txt or default) */
  crawlDelay: number;
  /** Whether crawling is allowed for this domain */
  isAllowed: boolean;
  /** When robots.txt was last fetched (null if never) */
  robotsFetchedAt: string | null;
  /** When this domain was first discovered */
  createdAt: string;
}

/**
 * Aggregated frontier statistics.
 * Provides counts by URL status.
 */
export interface FrontierStats {
  /** URLs waiting to be crawled */
  pending: number;
  /** URLs currently being processed */
  inProgress: number;
  /** URLs successfully completed */
  completed: number;
  /** URLs that failed */
  failed: number;
  /** Total unique domains in the frontier */
  totalDomains: number;
}
