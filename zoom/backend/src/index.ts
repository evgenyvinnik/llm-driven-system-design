import { createServer } from 'http';
import { app, sessionMiddleware } from './app.js';
import { config } from './config/index.js';
import { logger } from './services/logger.js';
import { setupWebSocket } from './websocket/handler.js';
import { reconcileOnStartup } from './websocket/meetingRooms.js';

const server = createServer(app);

// Signaling WebSocket on /ws, authenticated by the session cookie on the upgrade
const wss = setupWebSocket(server, sessionMiddleware);

reconcileOnStartup()
  .catch((err) => logger.error({ err }, 'Startup reconciliation failed'))
  .finally(() => {
    server.listen(config.port, () => {
      logger.info({ port: config.port, env: config.nodeEnv }, 'Zoom backend server started');
    });
  });

// Graceful shutdown
let shuttingDown = false;
function shutdown(signal: string) {
  // tsx watch can relay a signal that the process also receives directly.
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Shutting down gracefully');
  for (const client of wss.clients) {
    client.close(1001, 'Server shutting down');
  }
  wss.close();
  server.close(() => {
    process.exit(0);
  });
  // Open keep-alive or WebSocket connections must not hold the exit hostage.
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
