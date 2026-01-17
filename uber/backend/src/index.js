import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import config from './config/index.js';
import authRoutes from './routes/auth.js';
import rideRoutes from './routes/rides.js';
import driverRoutes from './routes/driver.js';
import matchingService from './services/matchingService.js';
import authService from './services/authService.js';

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

// Middleware
app.use(cors());
app.use(express.json());

// Request logging
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
  next();
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/rides', rideRoutes);
app.use('/api/driver', driverRoutes);

// WebSocket connection handling
wss.on('connection', async (ws, req) => {
  console.log('WebSocket connection established');

  let userId = null;

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message.toString());

      switch (data.type) {
        case 'auth':
          // Authenticate WebSocket connection
          const user = await authService.validateSession(data.token);
          if (user) {
            userId = user.id;
            matchingService.registerClient(userId, ws);
            ws.send(JSON.stringify({ type: 'auth_success', userId }));
            console.log(`User ${userId} authenticated via WebSocket`);
          } else {
            ws.send(JSON.stringify({ type: 'auth_error', error: 'Invalid token' }));
          }
          break;

        case 'location_update':
          // Driver location update
          if (userId && data.lat !== undefined && data.lng !== undefined) {
            const locationService = (await import('./services/locationService.js')).default;
            await locationService.updateDriverLocation(userId, data.lat, data.lng);

            // Broadcast location to connected rider if on an active ride
            // This would be enhanced in production
          }
          break;

        case 'ping':
          ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
          break;

        default:
          console.log('Unknown WebSocket message type:', data.type);
      }
    } catch (error) {
      console.error('WebSocket message error:', error);
    }
  });

  ws.on('close', () => {
    if (userId) {
      matchingService.unregisterClient(userId);
      console.log(`User ${userId} disconnected from WebSocket`);
    }
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });

  // Send initial connection acknowledgment
  ws.send(JSON.stringify({ type: 'connected', timestamp: Date.now() }));
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Start server
server.listen(config.port, () => {
  console.log(`Uber backend server running on port ${config.port}`);
  console.log(`Environment: ${config.nodeEnv}`);
  console.log(`WebSocket server ready`);
});

export default app;
