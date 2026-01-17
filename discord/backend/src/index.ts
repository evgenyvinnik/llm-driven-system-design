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
 * 6. Start TCP server (for netcat clients)
 * 7. Start HTTP server (for browser clients)
 *
 * The server supports graceful shutdown on SIGTERM/SIGINT.
 */

import dotenv from 'dotenv';
dotenv.config();

import { TCPServer, HTTPServer } from './adapters/index.js';
import { historyBuffer, messageRouter } from './core/index.js';
import { pubsubManager } from './utils/pubsub.js';
import { db } from './db/index.js';
import { logger } from './utils/logger.js';
import type { PubSubMessage, ChatMessage } from './types/index.js';

/** Instance ID for multi-instance deployments */
const instanceId = process.env.INSTANCE_ID || '1';
/** TCP server port (default: 9001) */
const tcpPort = parseInt(process.env.TCP_PORT || '9001', 10);
/** HTTP server port (default: 3001) */
const httpPort = parseInt(process.env.HTTP_PORT || '3001', 10);

/** TCP server instance */
let tcpServer: TCPServer;
/** HTTP server instance */
let httpServer: HTTPServer;

/**
 * Initialize and start the Baby Discord server.
 * Sets up all components and begins accepting connections.
 */
async function main() {
  logger.info(`Starting Baby Discord instance ${instanceId}`);

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

      logger.info('Redis pub/sub connected');
    } catch (error) {
      logger.warn('Redis connection failed - running in single-instance mode', { error });
    }

    // Start TCP server
    tcpServer = new TCPServer(tcpPort);
    await tcpServer.start();

    // Start HTTP server
    httpServer = new HTTPServer(httpPort);
    await httpServer.start();

    logger.info(`Baby Discord instance ${instanceId} is running`);
    logger.info(`TCP: nc localhost ${tcpPort}`);
    logger.info(`HTTP: http://localhost:${httpPort}`);
  } catch (error) {
    logger.error('Failed to start Baby Discord', { error });
    process.exit(1);
  }
}

/**
 * Perform graceful shutdown.
 * Closes all connections in reverse order of initialization.
 *
 * @param signal - The signal that triggered shutdown (SIGTERM or SIGINT)
 */
async function shutdown(signal: string) {
  logger.info(`Received ${signal}, shutting down gracefully...`);

  try {
    // Stop accepting new connections
    if (tcpServer) {
      await tcpServer.stop();
    }

    if (httpServer) {
      await httpServer.stop();
    }

    // Disconnect from Redis
    await pubsubManager.disconnect();

    // Close database connections
    await db.close();

    logger.info('Shutdown complete');
    process.exit(0);
  } catch (error) {
    logger.error('Error during shutdown', { error });
    process.exit(1);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Start the application
main();
