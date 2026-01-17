import dotenv from 'dotenv';
dotenv.config();

import { migrate } from './migrate';
import * as db from './repository';
import { logger } from '../utils/logger';

async function seed() {
  logger.info('Starting database seeding...');

  // Run migrations first
  await migrate();

  // Sample jobs
  const sampleJobs = [
    {
      name: 'daily-cleanup',
      description: 'Clean up old execution records',
      handler: 'system.cleanup',
      payload: { olderThanDays: 30 },
      schedule: '0 2 * * *', // 2 AM daily
      priority: 25,
    },
    {
      name: 'hourly-health-check',
      description: 'Check system health every hour',
      handler: 'http.webhook',
      payload: {
        url: 'http://localhost:3001/api/v1/health',
        method: 'GET',
        timeout: 10000,
      },
      schedule: '0 * * * *', // Every hour
      priority: 75,
    },
    {
      name: 'test-echo-job',
      description: 'Simple echo test job for development',
      handler: 'test.echo',
      payload: { message: 'Hello from the scheduler!' },
      priority: 50,
    },
    {
      name: 'quick-delay-test',
      description: 'Test job that delays for a short time',
      handler: 'test.delay',
      payload: { durationMs: 2000 },
      priority: 50,
    },
    {
      name: 'failing-test-job',
      description: 'Test job that fails (for retry testing)',
      handler: 'test.delay',
      payload: { durationMs: 500, shouldFail: true, failMessage: 'Intentional test failure' },
      priority: 30,
      max_retries: 3,
      initial_backoff_ms: 2000,
    },
    {
      name: 'every-5-minutes',
      description: 'Runs every 5 minutes',
      handler: 'test.log',
      payload: { message: '5-minute interval job executed', level: 'info' },
      schedule: '*/5 * * * *',
      priority: 50,
    },
  ];

  for (const jobData of sampleJobs) {
    try {
      // Check if job already exists
      const existing = await db.getJobByName(jobData.name);
      if (existing) {
        logger.info(`Job "${jobData.name}" already exists, skipping`);
        continue;
      }

      const job = await db.createJob(jobData);
      logger.info(`Created job: ${job.name} (${job.id})`);
    } catch (error) {
      logger.error(`Failed to create job "${jobData.name}"`, error);
    }
  }

  logger.info('Seeding completed');
  process.exit(0);
}

seed().catch((error) => {
  logger.error('Seeding failed', error);
  process.exit(1);
});
