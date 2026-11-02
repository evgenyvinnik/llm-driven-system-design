import http from 'http';
import { app, sessionMiddleware } from './app.js';
import config from './config/index.js';
import redis from './services/redis.js';
import logger, { logError } from './services/logger.js';
import pool from './services/db.js';
import { setupWebSocket } from './websocket/handler.js';
import { flushAllRooms } from './websocket/rooms.js';

let server: http.Server | null = null;

const startServer = async (): Promise<void> => {
  try {
    // Create HTTP server from Express app
    server = http.createServer(app);

    // Collaboration WebSocket on the same server, authenticated by the session cookie
    setupWebSocket(server, sessionMiddleware);

    // Start the server
    server.listen(config.port, () => {
      logger.info(
        {
          port: config.port,
          env: config.nodeEnv,
          pid: process.pid,
        },
        `Excalidraw API server running on port ${config.port}`
      );
    });
  } catch (error) {
    const err = error as Error;
    logError(err, { context: 'startup' });
    process.exit(1);
  }
};

// Graceful shutdown
let shuttingDown = false;

const gracefulShutdown = async (signal: string): Promise<void> => {
  // A signal can arrive twice (e.g. relayed by tsx and sent directly); a second
  // run would close the pool or exit while the first is still saving rooms.
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, `Received ${signal}, starting graceful shutdown`);

  // Stop accepting work, then save every open room before the pool closes:
  // otherwise up to one debounce window of edits per room is lost on restart.
  server?.close();
  server?.closeAllConnections();
  try {
    await flushAllRooms();
    logger.info('Open rooms saved');
  } catch (err) {
    logError(err as Error, { context: 'shutdown', component: 'rooms' });
  }

  try {
    await pool.end();
    logger.info('Database connections closed');
  } catch (err) {
    logError(err as Error, { context: 'shutdown', component: 'database' });
  }

  try {
    await redis.quit();
    logger.info('Redis connection closed');
  } catch (err) {
    logError(err as Error, { context: 'shutdown', component: 'redis' });
  }

  process.exit(0);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

startServer();
