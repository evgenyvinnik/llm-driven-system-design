/**
 * Database migration runner
 * Usage: npm run db:migrate
 */
import { migrate } from './models/migrate.js';

migrate()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
