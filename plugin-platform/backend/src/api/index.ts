import { app } from './app.js';
import { logger } from '../shared/logger.js';

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  logger.info({ port: PORT }, 'Plugin Platform API server started');
});
