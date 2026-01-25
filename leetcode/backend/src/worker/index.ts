import { createConsumer, TOPICS, type SubmissionJob, publishSubmissionResult, disconnectProducer } from '../shared/kafka.js';
import codeExecutor from '../services/codeExecutor.js';
import pool from '../db/pool.js';
import { createModuleLogger } from '../shared/logger.js';
import type { Consumer } from 'kafkajs';

const logger = createModuleLogger('worker');
const WORKER_ID = process.env.WORKER_ID || '1';
const GROUP_ID = 'submission-workers';

let consumer: Consumer | null = null;
let isShuttingDown = false;

/**
 * Process a submission job
 */
async function processSubmission(job: SubmissionJob): Promise<void> {
  const startTime = Date.now();
  logger.info({ submissionId: job.submissionId, language: job.language }, 'Processing submission');

  try {
    // Update submission status to 'running'
    await pool.query(
      'UPDATE submissions SET status = $1 WHERE id = $2',
      ['running', job.submissionId]
    );

    let testCasesPassed = 0;
    let totalRuntime = 0;
    let lastError: string | null = null;
    let finalStatus = 'accepted';

    // Run each test case
    for (const testCase of job.testCases) {
      if (isShuttingDown) {
        logger.warn({ submissionId: job.submissionId }, 'Shutdown requested, stopping test execution');
        break;
      }

      const result = await codeExecutor.execute(
        job.code,
        job.language,
        testCase.input,
        job.timeLimit,
        job.memoryLimit
      );

      totalRuntime += result.executionTime || 0;

      if (result.status === 'success') {
        // Compare output
        const isCorrect = codeExecutor.compareOutput(
          result.stdout || '',
          testCase.expectedOutput
        );

        if (isCorrect) {
          testCasesPassed++;
        } else {
          finalStatus = 'wrong_answer';
          lastError = `Expected: ${testCase.expectedOutput.substring(0, 100)}, Got: ${(result.stdout || '').substring(0, 100)}`;
        }
      } else if (result.status === 'time_limit_exceeded') {
        finalStatus = 'time_limit_exceeded';
        lastError = 'Time limit exceeded';
        break;
      } else if (result.status === 'memory_limit_exceeded') {
        finalStatus = 'memory_limit_exceeded';
        lastError = 'Memory limit exceeded';
        break;
      } else if (result.status === 'compilation_error') {
        finalStatus = 'compile_error';
        lastError = result.error || result.stderr || 'Compilation failed';
        break;
      } else if (result.status === 'runtime_error') {
        finalStatus = 'runtime_error';
        lastError = result.stderr || result.error || 'Runtime error';
        break;
      } else {
        finalStatus = 'system_error';
        lastError = result.error || 'Unknown error';
        break;
      }
    }

    // If all test cases passed, status is 'accepted'
    if (testCasesPassed === job.testCases.length) {
      finalStatus = 'accepted';
    }

    // Update submission in database
    await pool.query(
      `UPDATE submissions
       SET status = $1,
           test_cases_passed = $2,
           test_cases_total = $3,
           runtime_ms = $4,
           error_message = $5
       WHERE id = $6`,
      [finalStatus, testCasesPassed, job.testCases.length, totalRuntime, lastError, job.submissionId]
    );

    // Update user problem status if accepted
    if (finalStatus === 'accepted') {
      await pool.query(
        `INSERT INTO user_problem_status (user_id, problem_id, status, best_runtime_ms, attempts, solved_at)
         VALUES ($1, $2, 'solved', $3, 1, NOW())
         ON CONFLICT (user_id, problem_id) DO UPDATE SET
           status = 'solved',
           best_runtime_ms = LEAST(user_problem_status.best_runtime_ms, $3),
           attempts = user_problem_status.attempts + 1,
           solved_at = COALESCE(user_problem_status.solved_at, NOW())`,
        [job.userId, job.problemId, totalRuntime]
      );
    } else {
      await pool.query(
        `INSERT INTO user_problem_status (user_id, problem_id, status, attempts)
         VALUES ($1, $2, 'attempted', 1)
         ON CONFLICT (user_id, problem_id) DO UPDATE SET
           status = CASE
             WHEN user_problem_status.status = 'solved' THEN 'solved'
             ELSE 'attempted'
           END,
           attempts = user_problem_status.attempts + 1`,
        [job.userId, job.problemId]
      );
    }

    // Publish result to Kafka for any listeners
    await publishSubmissionResult({
      submissionId: job.submissionId,
      status: finalStatus,
      testCasesPassed,
      testCasesTotal: job.testCases.length,
      runtimeMs: totalRuntime,
      errorMessage: lastError || undefined,
    });

    const processingTime = Date.now() - startTime;
    logger.info({
      submissionId: job.submissionId,
      status: finalStatus,
      testCasesPassed,
      testCasesTotal: job.testCases.length,
      processingTimeMs: processingTime,
    }, 'Submission processed');

  } catch (error) {
    logger.error({
      submissionId: job.submissionId,
      error: (error as Error).message,
    }, 'Failed to process submission');

    // Update submission status to system_error
    await pool.query(
      `UPDATE submissions SET status = $1, error_message = $2 WHERE id = $3`,
      ['system_error', (error as Error).message, job.submissionId]
    );

    // Publish error result
    await publishSubmissionResult({
      submissionId: job.submissionId,
      status: 'system_error',
      testCasesPassed: 0,
      testCasesTotal: job.testCases.length,
      errorMessage: (error as Error).message,
    });
  }
}

/**
 * Start the worker
 */
async function start(): Promise<void> {
  logger.info({ workerId: WORKER_ID }, 'Starting submission worker');

  // Initialize code executor
  await codeExecutor.init();

  // Create consumer
  consumer = await createConsumer(GROUP_ID);

  // Subscribe to submissions topic
  await consumer.subscribe({
    topic: TOPICS.SUBMISSIONS,
    fromBeginning: false,
  });

  // Start consuming
  await consumer.run({
    eachMessage: async ({ topic, partition, message }) => {
      if (isShuttingDown) return;

      try {
        const job = JSON.parse(message.value?.toString() || '{}') as SubmissionJob;

        logger.debug({
          submissionId: job.submissionId,
          topic,
          partition,
          offset: message.offset,
        }, 'Received submission job');

        await processSubmission(job);
      } catch (error) {
        logger.error({
          error: (error as Error).message,
          topic,
          partition,
          offset: message.offset,
        }, 'Failed to process message');
      }
    },
  });

  logger.info({ workerId: WORKER_ID, groupId: GROUP_ID }, 'Worker started and consuming');
}

/**
 * Graceful shutdown
 */
async function shutdown(): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info({ workerId: WORKER_ID }, 'Shutting down worker');

  try {
    if (consumer) {
      await consumer.disconnect();
    }
    await disconnectProducer();
    await pool.end();
    logger.info('Worker shutdown complete');
  } catch (error) {
    logger.error({ error: (error as Error).message }, 'Error during shutdown');
  }

  process.exit(0);
}

// Handle shutdown signals
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Start the worker
start().catch((error) => {
  logger.error({ error: error.message }, 'Failed to start worker');
  process.exit(1);
});
