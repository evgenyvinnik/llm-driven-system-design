import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import { config } from './config/index.js';
import routes from './routes/index.js';
import { errorHandler, notFound } from './middleware/errorHandler.js';
import { initializeElasticsearch } from './config/elasticsearch.js';
import { ensureBuckets } from './config/minio.js';

const app = express();

// Middleware
app.use(helmet());
app.use(cors({
  origin: ['http://localhost:5173', 'http://localhost:3000'],
  credentials: true,
}));
app.use(morgan('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// API routes
app.use(`/api/${config.api.version}`, routes);

// Error handling
app.use(notFound);
app.use(errorHandler);

// Start server
async function start() {
  try {
    // Initialize services
    console.log('Initializing Elasticsearch...');
    await initializeElasticsearch();

    console.log('Initializing MinIO buckets...');
    await ensureBuckets();

    app.listen(config.port, () => {
      console.log(`Server running on http://localhost:${config.port}`);
      console.log(`API available at http://localhost:${config.port}/api/${config.api.version}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

start();

export default app;
