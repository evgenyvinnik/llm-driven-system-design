import { Kafka, Producer, Consumer, logLevel } from 'kafkajs';
import { createModuleLogger } from './logger.js';

const logger = createModuleLogger('kafka');

// Kafka configuration
const KAFKA_BROKERS = process.env.KAFKA_BROKERS?.split(',') || ['localhost:9092'];
const KAFKA_CLIENT_ID = process.env.KAFKA_CLIENT_ID || 'leetcode-backend';

// Topic names
export const TOPICS = {
  SUBMISSIONS: 'submissions',
  SUBMISSION_RESULTS: 'submission-results',
} as const;

// Create Kafka instance
const kafka = new Kafka({
  clientId: KAFKA_CLIENT_ID,
  brokers: KAFKA_BROKERS,
  logLevel: logLevel.WARN,
  retry: {
    initialRetryTime: 100,
    retries: 8,
  },
});

// Singleton producer
let producer: Producer | null = null;

/**
 * Get or create the Kafka producer
 */
export async function getProducer(): Promise<Producer> {
  if (!producer) {
    producer = kafka.producer({
      allowAutoTopicCreation: true,
      transactionTimeout: 30000,
    });

    producer.on('producer.connect', () => {
      logger.info('Kafka producer connected');
    });

    producer.on('producer.disconnect', () => {
      logger.warn('Kafka producer disconnected');
    });

    await producer.connect();
  }
  return producer;
}

/**
 * Create a Kafka consumer for a specific group
 */
export async function createConsumer(groupId: string): Promise<Consumer> {
  const consumer = kafka.consumer({
    groupId,
    sessionTimeout: 30000,
    heartbeatInterval: 3000,
  });

  consumer.on('consumer.connect', () => {
    logger.info({ groupId }, 'Kafka consumer connected');
  });

  consumer.on('consumer.disconnect', () => {
    logger.warn({ groupId }, 'Kafka consumer disconnected');
  });

  consumer.on('consumer.crash', ({ payload }) => {
    logger.error({ groupId, error: payload.error }, 'Kafka consumer crashed');
  });

  await consumer.connect();
  return consumer;
}

/**
 * Submission job payload
 */
export interface SubmissionJob {
  submissionId: string;
  userId: string;
  problemId: string;
  code: string;
  language: string;
  testCases: Array<{
    id: string;
    input: string;
    expectedOutput: string;
    isSample: boolean;
  }>;
  timeLimit: number;
  memoryLimit: number;
  createdAt: string;
}

/**
 * Submission result payload
 */
export interface SubmissionResult {
  submissionId: string;
  status: string;
  testCasesPassed: number;
  testCasesTotal: number;
  runtimeMs?: number;
  memoryKb?: number;
  errorMessage?: string;
  testResults?: Array<{
    testCaseId: string;
    status: string;
    output?: string;
    expectedOutput?: string;
    runtimeMs?: number;
  }>;
}

/**
 * Publish a submission job to Kafka
 */
export async function publishSubmissionJob(job: SubmissionJob): Promise<void> {
  const prod = await getProducer();

  await prod.send({
    topic: TOPICS.SUBMISSIONS,
    messages: [
      {
        key: job.submissionId,
        value: JSON.stringify(job),
        headers: {
          'content-type': 'application/json',
          'created-at': new Date().toISOString(),
        },
      },
    ],
  });

  logger.info({ submissionId: job.submissionId }, 'Published submission job to Kafka');
}

/**
 * Publish a submission result to Kafka
 */
export async function publishSubmissionResult(result: SubmissionResult): Promise<void> {
  const prod = await getProducer();

  await prod.send({
    topic: TOPICS.SUBMISSION_RESULTS,
    messages: [
      {
        key: result.submissionId,
        value: JSON.stringify(result),
        headers: {
          'content-type': 'application/json',
          'completed-at': new Date().toISOString(),
        },
      },
    ],
  });

  logger.debug({ submissionId: result.submissionId }, 'Published submission result to Kafka');
}

/**
 * Gracefully disconnect Kafka producer
 */
export async function disconnectProducer(): Promise<void> {
  if (producer) {
    await producer.disconnect();
    producer = null;
    logger.info('Kafka producer disconnected');
  }
}

export default kafka;
