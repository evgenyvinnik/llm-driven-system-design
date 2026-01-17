/**
 * Persistence Module
 *
 * Provides snapshot-based persistence for the distributed cache.
 * Features:
 * - Periodic snapshots to disk
 * - Cache warmup from snapshot on startup
 * - Configurable retention policy
 */

import fs from 'fs/promises';
import path from 'path';
import {
  snapshotsCreated,
  snapshotsLoaded,
  snapshotEntriesLoaded,
  snapshotDuration,
} from './metrics.js';
import {
  logSnapshotCreated,
  logSnapshotLoaded,
  persistenceLogger,
} from './logger.js';

// Configuration from environment
const PERSISTENCE_ENABLED =
  (process.env.PERSISTENCE_ENABLED || 'true') === 'true';
const SNAPSHOT_INTERVAL_MS = parseInt(
  process.env.SNAPSHOT_INTERVAL_MS || '60000',
  10
); // 1 minute
const SNAPSHOT_DIR = process.env.SNAPSHOT_DIR || './data';
const MAX_SNAPSHOTS = parseInt(process.env.MAX_SNAPSHOTS || '3', 10);

/**
 * Persistence Manager class
 * Handles snapshot creation, loading, and cleanup
 */
export class PersistenceManager {
  constructor(nodeId, cache, options = {}) {
    this.nodeId = nodeId;
    this.cache = cache;
    this.enabled = options.enabled ?? PERSISTENCE_ENABLED;
    this.snapshotInterval = options.snapshotInterval ?? SNAPSHOT_INTERVAL_MS;
    this.snapshotDir = options.snapshotDir ?? SNAPSHOT_DIR;
    this.maxSnapshots = options.maxSnapshots ?? MAX_SNAPSHOTS;

    this.nodeDir = path.join(this.snapshotDir, this.nodeId);
    this.intervalHandle = null;
    this.isSnapshotting = false;
  }

  /**
   * Initialize persistence - create directories and load last snapshot
   */
  async initialize() {
    if (!this.enabled) {
      persistenceLogger.info({ nodeId: this.nodeId }, 'persistence_disabled');
      return { loaded: false, entries: 0 };
    }

    // Ensure snapshot directory exists
    try {
      await fs.mkdir(this.nodeDir, { recursive: true });
      persistenceLogger.debug(
        { nodeId: this.nodeId, dir: this.nodeDir },
        'snapshot_directory_ready'
      );
    } catch (error) {
      persistenceLogger.error(
        { nodeId: this.nodeId, error: error.message },
        'failed_to_create_snapshot_directory'
      );
      throw error;
    }

    // Load the most recent snapshot
    const loadResult = await this.loadSnapshot();

    // Start periodic snapshots
    this.startPeriodicSnapshots();

    return loadResult;
  }

  /**
   * Start periodic snapshot creation
   */
  startPeriodicSnapshots() {
    if (!this.enabled) return;

    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
    }

    this.intervalHandle = setInterval(async () => {
      try {
        await this.createSnapshot();
      } catch (error) {
        persistenceLogger.error(
          { nodeId: this.nodeId, error: error.message },
          'periodic_snapshot_failed'
        );
      }
    }, this.snapshotInterval);

    persistenceLogger.info(
      { nodeId: this.nodeId, intervalMs: this.snapshotInterval },
      'periodic_snapshots_started'
    );
  }

  /**
   * Stop periodic snapshots
   */
  stopPeriodicSnapshots() {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  /**
   * Create a snapshot of the current cache state
   * @returns {Promise<object>} Snapshot metadata
   */
  async createSnapshot() {
    if (!this.enabled || this.isSnapshotting) {
      return null;
    }

    this.isSnapshotting = true;
    const startTime = Date.now();

    try {
      // Get all cache entries
      const entries = [];
      const keys = this.cache.keys('*');

      for (const key of keys) {
        const info = this.cache.getKeyInfo(key);
        if (info) {
          const item = this.cache.cache.get(key);
          if (item) {
            entries.push({
              key,
              value: item.value,
              expiresAt: item.expiresAt,
              createdAt: item.createdAt,
              updatedAt: item.updatedAt,
            });
          }
        }
      }

      // Create snapshot object
      const snapshot = {
        version: 1,
        nodeId: this.nodeId,
        timestamp: Date.now(),
        entries,
        stats: this.cache.getStats(),
      };

      // Write to file
      const filename = `snapshot-${snapshot.timestamp}.json`;
      const filepath = path.join(this.nodeDir, filename);

      await fs.writeFile(filepath, JSON.stringify(snapshot, null, 2), 'utf-8');

      const durationMs = Date.now() - startTime;

      // Update metrics
      snapshotsCreated.labels(this.nodeId).inc();
      snapshotDuration.labels(this.nodeId).observe(durationMs / 1000);

      logSnapshotCreated(this.nodeId, entries.length, durationMs);

      // Clean up old snapshots
      await this.cleanupOldSnapshots();

      return {
        filename,
        entries: entries.length,
        durationMs,
        timestamp: snapshot.timestamp,
      };
    } catch (error) {
      persistenceLogger.error(
        { nodeId: this.nodeId, error: error.message },
        'snapshot_creation_failed'
      );
      throw error;
    } finally {
      this.isSnapshotting = false;
    }
  }

  /**
   * Load the most recent snapshot
   * @returns {Promise<object>} Load result
   */
  async loadSnapshot() {
    try {
      // List snapshot files
      const files = await fs.readdir(this.nodeDir);
      const snapshotFiles = files
        .filter((f) => f.startsWith('snapshot-') && f.endsWith('.json'))
        .sort()
        .reverse();

      if (snapshotFiles.length === 0) {
        persistenceLogger.info(
          { nodeId: this.nodeId },
          'no_snapshot_found'
        );
        return { loaded: false, entries: 0 };
      }

      // Load the most recent snapshot
      const latestFile = snapshotFiles[0];
      const filepath = path.join(this.nodeDir, latestFile);

      const startTime = Date.now();
      const content = await fs.readFile(filepath, 'utf-8');
      const snapshot = JSON.parse(content);

      // Validate snapshot version
      if (snapshot.version !== 1) {
        persistenceLogger.warn(
          { nodeId: this.nodeId, version: snapshot.version },
          'incompatible_snapshot_version'
        );
        return { loaded: false, entries: 0 };
      }

      // Load entries into cache
      let loaded = 0;
      let skippedExpired = 0;
      const now = Date.now();

      // Sort by updatedAt descending to load most recent entries first
      const sortedEntries = [...snapshot.entries].sort(
        (a, b) => b.updatedAt - a.updatedAt
      );

      for (const entry of sortedEntries) {
        // Skip expired entries
        if (entry.expiresAt !== 0 && entry.expiresAt <= now) {
          skippedExpired++;
          continue;
        }

        // Calculate remaining TTL
        let ttl = 0;
        if (entry.expiresAt !== 0) {
          ttl = Math.ceil((entry.expiresAt - now) / 1000);
          if (ttl <= 0) {
            skippedExpired++;
            continue;
          }
        }

        // Set in cache
        this.cache.set(entry.key, entry.value, ttl);
        loaded++;
      }

      const durationMs = Date.now() - startTime;

      // Update metrics
      snapshotsLoaded.labels(this.nodeId).inc();
      snapshotEntriesLoaded.labels(this.nodeId).set(loaded);

      logSnapshotLoaded(this.nodeId, loaded, durationMs);

      persistenceLogger.info(
        {
          nodeId: this.nodeId,
          file: latestFile,
          totalEntries: snapshot.entries.length,
          loadedEntries: loaded,
          skippedExpired,
          durationMs,
        },
        'snapshot_loaded'
      );

      return {
        loaded: true,
        entries: loaded,
        skippedExpired,
        durationMs,
        snapshotTimestamp: snapshot.timestamp,
      };
    } catch (error) {
      if (error.code === 'ENOENT') {
        persistenceLogger.info(
          { nodeId: this.nodeId },
          'no_snapshot_directory'
        );
        return { loaded: false, entries: 0 };
      }

      persistenceLogger.error(
        { nodeId: this.nodeId, error: error.message },
        'snapshot_load_failed'
      );
      return { loaded: false, entries: 0, error: error.message };
    }
  }

  /**
   * Clean up old snapshots, keeping only the most recent ones
   */
  async cleanupOldSnapshots() {
    try {
      const files = await fs.readdir(this.nodeDir);
      const snapshotFiles = files
        .filter((f) => f.startsWith('snapshot-') && f.endsWith('.json'))
        .sort()
        .reverse();

      if (snapshotFiles.length <= this.maxSnapshots) {
        return;
      }

      const toDelete = snapshotFiles.slice(this.maxSnapshots);

      for (const file of toDelete) {
        const filepath = path.join(this.nodeDir, file);
        await fs.unlink(filepath);
        persistenceLogger.debug(
          { nodeId: this.nodeId, file },
          'old_snapshot_deleted'
        );
      }
    } catch (error) {
      persistenceLogger.warn(
        { nodeId: this.nodeId, error: error.message },
        'snapshot_cleanup_failed'
      );
    }
  }

  /**
   * Force an immediate snapshot
   * @returns {Promise<object>}
   */
  async forceSnapshot() {
    return this.createSnapshot();
  }

  /**
   * Get list of available snapshots
   * @returns {Promise<Array>}
   */
  async listSnapshots() {
    try {
      const files = await fs.readdir(this.nodeDir);
      const snapshotFiles = files
        .filter((f) => f.startsWith('snapshot-') && f.endsWith('.json'))
        .sort()
        .reverse();

      const snapshots = [];

      for (const file of snapshotFiles) {
        const filepath = path.join(this.nodeDir, file);
        const stat = await fs.stat(filepath);

        // Extract timestamp from filename
        const match = file.match(/snapshot-(\d+)\.json/);
        const timestamp = match ? parseInt(match[1], 10) : 0;

        snapshots.push({
          filename: file,
          timestamp,
          date: new Date(timestamp).toISOString(),
          sizeBytes: stat.size,
        });
      }

      return snapshots;
    } catch (error) {
      if (error.code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  /**
   * Clean up and shutdown
   */
  async shutdown() {
    this.stopPeriodicSnapshots();

    // Create final snapshot before shutdown
    if (this.enabled) {
      try {
        await this.createSnapshot();
        persistenceLogger.info(
          { nodeId: this.nodeId },
          'shutdown_snapshot_created'
        );
      } catch (error) {
        persistenceLogger.error(
          { nodeId: this.nodeId, error: error.message },
          'shutdown_snapshot_failed'
        );
      }
    }
  }
}

/**
 * Create a persistence manager for a cache node
 * @param {string} nodeId
 * @param {object} cache - LRU Cache instance
 * @param {object} options
 * @returns {PersistenceManager}
 */
export function createPersistenceManager(nodeId, cache, options = {}) {
  return new PersistenceManager(nodeId, cache, options);
}

export default {
  PersistenceManager,
  createPersistenceManager,
};
