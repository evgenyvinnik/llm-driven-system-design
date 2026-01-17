/**
 * Baby Discord Server Entry Point
 *
 * This is the main entry point for the Baby Discord server.
 * It initializes all components and starts both TCP and HTTP servers.
 *
 * Startup sequence:
 * 1. Load environment variables
 * 2. Verify database connection
 * 3. Load message history into memory
 * 4. Connect to Redis for pub/sub (optional - degrades gracefully)
 * 5. Subscribe to existing room channels
 * 6. Start cleanup job for message retention
 * 7. Start TCP server (for netcat clients)
 * 8. Start HTTP server (for browser clients with /metrics and /health)
 *
 * The server supports graceful shutdown on SIGTERM/SIGINT.
 *
 * WHY Graceful Shutdown Prevents Message Loss:
 * - Stops accepting new connections immediately
 * - Notifies connected clients of impending shutdown
 * - Allows in-flight messages to complete
 * - Flushes database writes before closing connections
 * - Gives load balancers time to route traffic elsewhere
 */

import dotenv from 'dotenv';
dotenv.config();

import { TCPServer, HTTPServer } from './adapters/index.js';
import { historyBuffer, messageRouter } from './core/index.js';
import { pubsubManager } from './utils/pubsub.js';
import { db } from './db/index.js';
import { logger, flushLogs } from './utils/logger.js';
import { startCleanupJob, stopCleanupJob } from './utils/cleanup.js';
import { server, shutdown as shutdownConfig } from './shared/config.js';
import { pubsubConnectionStatus, subscribedChannels } from './shared/metrics.js';
import type { PubSubMessage, ChatMessage } from './types/index.js';

/** Instance ID for multi-instance deployments */
const instanceId = server.instanceId;
/** TCP server port (default: 9001) */
const tcpPort = server.tcpPort;
/** HTTP server port (default: 3001) */
const httpPort = server.httpPort;

/** TCP server instance */
let tcpServer: TCPServer;
/** HTTP server instance */
let httpServer: HTTPServer;
/** Whether shutdown is in progress */
let isShuttingDown = false;

/**
 * Initialize and start the Baby Discord server.
 * Sets up all components and begins accepting connections.
 */
async function main() {
  logger.info({ instanceId }, 'Starting Baby Discord server');

  try {
    // Check database connection
    const dbHealthy = await db.healthCheck();
    if (!dbHealthy) {
      throw new Error('Database connection failed');
    }
    logger.info('Database connection verified');

    // Load message history from database
    await historyBuffer.loadFromDB();

    // Connect to Redis for pub/sub
    try {
      await pubsubManager.connect();

      // Update metrics
      pubsubConnectionStatus.labels({ instance: instanceId }).set(1);

      // Set up pub/sub handler
      pubsubManager.setMessageHandler((msg: PubSubMessage) => {
        messageRouter.handlePubSubMessage(msg);
      });

      // Set up message router to publish to pub/sub
      messageRouter.setPubSubHandler(async (msg: PubSubMessage) => {
        await pubsubManager.publishToRoom(msg.room, msg);
      });

      // Subscribe to all existing rooms
      const rooms = await db.query<{ name: string }>('SELECT name FROM rooms');
      for (const room of rooms.rows) {
        await pubsubManager.subscribeToRoom(room.name);
      }

      // Update metrics
      subscribedChannels.labels({ instance: instanceId }).set(rooms.rows.length);

      logger.info('Redis pub/sub connected');
    } catch (error) {
      pubsubConnectionStatus.labels({ instance: instanceId }).set(0);
      logger.warn({ err: error }, 'Redis connection failed - running in single-instance mode');
    }

    // Start message cleanup job
    startCleanupJob();

    // Start TCP server
    tcpServer = new TCPServer(tcpPort);
    await tcpServer.start();

    // Start HTTP server
    httpServer = new HTTPServer(httpPort);
    await httpServer.start();

    logger.info({ instanceId, tcpPort, httpPort }, 'Baby Discord server is running');
    logger.info(`TCP: nc localhost ${tcpPort}`);
    logger.info(`HTTP: http://localhost:${httpPort}`);
    logger.info(`Metrics: http://localhost:${httpPort}/metrics`);
    logger.info(`Health: http://localhost:${httpPort}/health`);
  } catch (error) {
    logger.error({ err: error }, 'Failed to start Baby Discord');
    process.exit(1);
  }
}

/**
 * Perform graceful shutdown.
 * Closes all connections in reverse order of initialization.
 *
 * Shutdown sequence:
 * 1. Stop accepting new connections (enter drain mode)
 * 2. Notify connected clients of impending shutdown
 * 3. Wait for grace period (allow in-flight requests to complete)
 * 4. Stop cleanup job
 * 5. Disconnect from Redis
 * 6. Close database connections
 * 7. Flush logs
 * 8. Exit
 *
 * @param signal - The signal that triggered shutdown (SIGTERM or SIGINT)
 */
async function shutdown(signal: string) {
  if (isShuttingDown) {
    logger.warn('Shutdown already in progress, ignoring signal');
    return;
  }

  isShuttingDown = true;
  const startTime = Date.now();
  logger.info({ signal, gracePeriodMs: shutdownConfig.gracePeriodMs }, 'Received shutdown signal, starting graceful shutdown');

  try {
    // Stop accepting new connections and notify clients
    const stopPromises: Promise<void>[] = [];

    if (tcpServer) {
      stopPromises.push(tcpServer.stop(shutdownConfig.gracePeriodMs));
    }

    if (httpServer) {
      stopPromises.push(httpServer.stop(shutdownConfig.gracePeriodMs));
    }

    // Wait for servers to drain
    await Promise.all(stopPromises);
    logger.info('Servers stopped');

    // Stop cleanup job
    stopCleanupJob();
    logger.info('Cleanup job stopped');

    // Disconnect from Redis
    await pubsubManager.disconnect();
    logger.info('Redis disconnected');

    // Close database connections
    await db.close();
    logger.info('Database connections closed');

    // Flush logs before exit
    await flushLogs();

    const duration = Date.now() - startTime;
    logger.info({ durationMs: duration }, 'Graceful shutdown complete');

    process.exit(0);
  } catch (error) {
    logger.error({ err: error }, 'Error during shutdown');
    process.exit(1);
  }
}

/**
 * Handle uncaught exceptions.
 * Logs the error and attempts graceful shutdown.
 */
process.on('uncaughtException', (error) => {
  logger.error({ err: error }, 'Uncaught exception');
  shutdown('uncaughtException');
});

/**
 * Handle unhandled promise rejections.
 * Logs the error and attempts graceful shutdown.
 */
process.on('unhandledRejection', (reason, promise) => {
  logger.error({ reason, promise }, 'Unhandled promise rejection');
  shutdown('unhandledRejection');
});

// Register signal handlers
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Start the application
main();
