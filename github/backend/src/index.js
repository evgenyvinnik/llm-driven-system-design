import express from 'express';
import cors from 'cors';
import { authMiddleware, login, register, logout, getCurrentUser } from './middleware/auth.js';
import { initializeCodeIndex } from './db/elasticsearch.js';
import reposRoutes from './routes/repos.js';
import pullsRoutes from './routes/pulls.js';
import issuesRoutes from './routes/issues.js';
import discussionsRoutes from './routes/discussions.js';
import usersRoutes from './routes/users.js';
import searchRoutes from './routes/search.js';

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));
app.use(authMiddleware);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Auth routes
app.post('/api/auth/login', login);
app.post('/api/auth/register', register);
app.post('/api/auth/logout', logout);
app.get('/api/auth/me', getCurrentUser);

// API routes
app.use('/api/repos', reposRoutes);
app.use('/api', pullsRoutes);  // Routes include /:owner/:repo/pulls
app.use('/api', issuesRoutes); // Routes include /:owner/:repo/issues
app.use('/api', discussionsRoutes); // Routes include /:owner/:repo/discussions
app.use('/api/users', usersRoutes);
app.use('/api/search', searchRoutes);

// Error handler
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
async function start() {
  try {
    // Initialize Elasticsearch index
    await initializeCodeIndex();
    console.log('Elasticsearch index initialized');
  } catch (err) {
    console.warn('Elasticsearch not available:', err.message);
  }

  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  });
}

start();
