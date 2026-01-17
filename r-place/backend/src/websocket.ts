import { WebSocketServer, WebSocket } from 'ws';
import { Server } from 'http';
import { parse as parseCookie } from 'cookie';
import { redisSub } from '../services/redis.js';
import { canvasService } from '../services/canvas.js';
import { authService } from '../services/auth.js';
import { REDIS_KEYS } from '../config.js';
import type { PixelEvent, User } from '../types/index.js';

interface ExtendedWebSocket extends WebSocket {
  userId?: string;
  username?: string;
  isAlive: boolean;
}

export function setupWebSocket(server: Server): WebSocketServer {
  const wss = new WebSocketServer({ server, path: '/ws' });

  const clients = new Set<ExtendedWebSocket>();

  // Subscribe to Redis pixel updates
  redisSub.subscribe(REDIS_KEYS.PIXEL_CHANNEL, (err) => {
    if (err) {
      console.error('Failed to subscribe to pixel updates:', err);
    } else {
      console.log('Subscribed to pixel updates channel');
    }
  });

  // Handle incoming pixel events from Redis
  redisSub.on('message', (channel, message) => {
    if (channel === REDIS_KEYS.PIXEL_CHANNEL) {
      const event: PixelEvent = JSON.parse(message);
      broadcastPixel(event);
    }
  });

  // Broadcast pixel update to all connected clients
  function broadcastPixel(event: PixelEvent): void {
    const message = JSON.stringify({
      type: 'pixel',
      data: event,
    });

    clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  }

  // Handle new WebSocket connections
  wss.on('connection', async (ws: ExtendedWebSocket, req) => {
    ws.isAlive = true;

    // Extract session from cookies
    const cookies = req.headers.cookie ? parseCookie(req.headers.cookie) : {};
    const sessionId = cookies.session;

    let user: User | null = null;
    if (sessionId) {
      user = await authService.validateSession(sessionId);
    }

    if (user) {
      ws.userId = user.id;
      ws.username = user.username;
    }

    clients.add(ws);
    console.log(`WebSocket client connected: ${user?.username || 'anonymous'} (${clients.size} total)`);

    // Send initial canvas state
    try {
      const canvasBase64 = await canvasService.getCanvasBase64();
      ws.send(JSON.stringify({
        type: 'canvas',
        data: canvasBase64,
      }));

      // Send connection confirmation
      ws.send(JSON.stringify({
        type: 'connected',
        data: {
          userId: ws.userId,
          username: ws.username,
          authenticated: !!user,
        },
      }));

      // Send cooldown status if authenticated
      if (user) {
        const cooldown = await canvasService.checkCooldown(user.id);
        ws.send(JSON.stringify({
          type: 'cooldown',
          data: {
            canPlace: cooldown.canPlace,
            remainingSeconds: cooldown.remainingSeconds,
            nextPlacement: cooldown.canPlace ? Date.now() : Date.now() + cooldown.remainingSeconds * 1000,
          },
        }));
      }
    } catch (error) {
      console.error('Error sending initial state:', error);
      ws.send(JSON.stringify({
        type: 'error',
        data: 'Failed to load canvas',
      }));
    }

    // Handle ping/pong for connection health
    ws.on('pong', () => {
      ws.isAlive = true;
    });

    // Handle incoming messages from client
    ws.on('message', async (data) => {
      try {
        const message = JSON.parse(data.toString());

        if (message.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }));
        }
      } catch (error) {
        console.error('Error handling WebSocket message:', error);
      }
    });

    // Handle disconnection
    ws.on('close', () => {
      clients.delete(ws);
      console.log(`WebSocket client disconnected: ${ws.username || 'anonymous'} (${clients.size} total)`);
    });

    ws.on('error', (error) => {
      console.error('WebSocket error:', error);
      clients.delete(ws);
    });
  });

  // Heartbeat interval to detect dead connections
  const heartbeatInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
      const extWs = ws as ExtendedWebSocket;
      if (!extWs.isAlive) {
        clients.delete(extWs);
        return extWs.terminate();
      }
      extWs.isAlive = false;
      extWs.ping();
    });
  }, 30000);

  wss.on('close', () => {
    clearInterval(heartbeatInterval);
  });

  console.log('WebSocket server initialized');
  return wss;
}
