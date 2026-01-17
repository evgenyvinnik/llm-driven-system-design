import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';

import authRoutes from './routes/auth.routes.js';
import eventsRoutes from './routes/events.routes.js';
import venuesRoutes from './routes/venues.routes.js';
import seatsRoutes from './routes/seats.routes.js';
import queueRoutes from './routes/queue.routes.js';
import checkoutRoutes from './routes/checkout.routes.js';
import { seatService } from './services/seat.service.js';
import { eventService } from './services/event.service.js';
import { waitingRoomService } from './services/waiting-room.service.js';

const app = express();
const PORT = parseInt(process.env.PORT || '3001');

// Middleware
app.use(cors({
  origin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  credentials: true,
}));
app.use(express.json());
app.use(cookieParser());

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API Routes
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/events', eventsRoutes);
app.use('/api/v1/venues', venuesRoutes);
app.use('/api/v1/seats', seatsRoutes);
app.use('/api/v1/queue', queueRoutes);
app.use('/api/v1/checkout', checkoutRoutes);

// Error handling middleware
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ success: false, error: 'Internal server error' });
});

// Background jobs
const startBackgroundJobs = () => {
  // Cleanup expired seat holds every minute
  setInterval(async () => {
    try {
      const released = await seatService.cleanupExpiredHolds();
      if (released > 0) {
        console.log(`Released ${released} expired seat holds`);
      }
    } catch (error) {
      console.error('Error cleaning up expired holds:', error);
    }
  }, 60000);

  // Check for events that should start on-sale
  setInterval(async () => {
    try {
      const upcomingEvents = await eventService.getUpcomingOnSales();
      for (const event of upcomingEvents) {
        console.log(`Starting on-sale for event: ${event.name}`);
        await eventService.updateEventStatus(event.id, 'on_sale');

        // Start waiting room processor if enabled
        if (event.waiting_room_enabled) {
          waitingRoomService.startQueueProcessor(event.id, event.max_concurrent_shoppers);
        }
      }
    } catch (error) {
      console.error('Error checking upcoming on-sales:', error);
    }
  }, 30000);

  console.log('Background jobs started');
};

// Start server
app.listen(PORT, () => {
  console.log(`Ticketmaster API server running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  startBackgroundJobs();
});

export default app;
