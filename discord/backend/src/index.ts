import dotenv from 'dotenv';
dotenv.config();

import { TCPServer, HTTPServer } from './adapters/index.js';
import { historyBuffer, messageRouter } from './core/index.js';
import { pubsubManager } from './utils/pubsub.js';
import { db } from './db/index.js';
import { logger } from './utils/logger.js';
import type { PubSubMessage, ChatMessage } from './types/index.js';

const instanceId = process.env.INSTANCE_ID || '1';
const tcpPort = parseInt(process.env.TCP_PORT || '9001', 10);
const httpPort = parseInt(process.env.HTTP_PORT || '3001', 10);

let tcpServer: TCPServer;
let httpServer: HTTPServer;

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

// Graceful shutdown
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
