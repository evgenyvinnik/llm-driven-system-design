const express = require('express');
const cors = require('cors');
const config = require('./config');
const elasticsearch = require('./models/elasticsearch');
const bookingService = require('./services/bookingService');

// Import routes
const authRoutes = require('./routes/auth');
const hotelRoutes = require('./routes/hotels');
const bookingRoutes = require('./routes/bookings');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API routes
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/hotels', hotelRoutes);
app.use('/api/v1/bookings', bookingRoutes);

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Background job: Expire stale reservations
let expiryInterval;

async function startExpiryJob() {
  expiryInterval = setInterval(async () => {
    try {
      const expired = await bookingService.expireStaleReservations();
      if (expired > 0) {
        console.log(`Expired ${expired} stale reservations`);
      }
    } catch (error) {
      console.error('Error expiring reservations:', error);
    }
  }, 60000); // Run every minute
}

// Start server
async function start() {
  try {
    // Setup Elasticsearch index
    await elasticsearch.setupIndex();
    console.log('Elasticsearch index ready');

    // Start background jobs
    startExpiryJob();

    app.listen(config.port, () => {
      console.log(`Server running on port ${config.port}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  if (expiryInterval) {
    clearInterval(expiryInterval);
  }
  process.exit(0);
});

start();
