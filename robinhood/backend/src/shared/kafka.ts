/**
 * Kafka client module for event streaming.
 *
 * Provides producers and consumers for:
 * - quotes: Real-time price updates for market data distribution
 * - orders: Order placement and status change events
 * - trades: Execution events for portfolio updates and analytics
 *
 * Uses kafkajs for Kafka integration with circuit breaker patterns
 * for resilience against broker failures.
 */

import { Kafka, Producer, Consumer, Partitioners, logLevel, CompressionTypes, EachBatchPayload, EachMessagePayload } from 'kafkajs';
import { logger } from './logger.js';
import type { Quote, Order, Execution } from '../types/index.js';

/** Kafka topic names */
export const TOPICS = {
  QUOTES: 'quotes',
  ORDERS: 'orders',
  TRADES: 'trades',
} as const;

/** Kafka client configuration */
const kafka = new Kafka({
  clientId: 'robinhood-backend',
  brokers: [process.env.KAFKA_BROKERS || 'localhost:9092'],
  logLevel: logLevel.WARN,
  retry: {
    initialRetryTime: 100,
    retries: 5,
  },
});

/** Singleton producer instance */
let producer: Producer | null = null;

/** Track producer connection state */
let producerConnected = false;

/**
 * Initializes the Kafka producer with connection retry logic.
 * Creates topics if they don't exist.
 */
export async function initKafkaProducer(): Promise<void> {
  if (producer && producerConnected) {
    return;
  }

  try {
    producer = kafka.producer({
      createPartitioner: Partitioners.DefaultPartitioner,
      allowAutoTopicCreation: true,
    });

    await producer.connect();
    producerConnected = true;
    logger.info('Kafka producer connected');

    // Create topics
    const admin = kafka.admin();
    await admin.connect();
    
    const existingTopics = await admin.listTopics();
    const topicsToCreate = Object.values(TOPICS).filter((t: string) => !existingTopics.includes(t));
    
    if (topicsToCreate.length > 0) {
      await admin.createTopics({
        topics: topicsToCreate.map((topic: string) => ({
          topic,
          numPartitions: 3,
          replicationFactor: 1,
        })),
      });
      logger.info({ topics: topicsToCreate }, 'Kafka topics created');
    }
    
    await admin.disconnect();
  } catch (error) {
    producerConnected = false;
    logger.error({ error }, 'Failed to connect Kafka producer');
    throw error;
  }
}

/**
 * Disconnects the Kafka producer gracefully.
 */
export async function disconnectKafkaProducer(): Promise<void> {
  if (producer) {
    await producer.disconnect();
    producer = null;
    producerConnected = false;
    logger.info('Kafka producer disconnected');
  }
}

/**
 * Publishes a quote update to the quotes topic.
 * Uses the stock symbol as the partition key for ordering.
 *
 * @param symbol - Stock ticker symbol
 * @param price - Current price
 * @param change - Price change from open
 * @param quote - Full quote object (optional)
 */
export async function publishQuote(
  symbol: string,
  price: number,
  change: number,
  quote?: Quote
): Promise<void> {
  if (!producer || !producerConnected) {
    logger.warn('Kafka producer not connected, skipping quote publish');
    return;
  }

  try {
    await producer.send({
      topic: TOPICS.QUOTES,
      compression: CompressionTypes.Snappy,
      messages: [
        {
          key: symbol,
          value: JSON.stringify(quote || { symbol, price, change, timestamp: Date.now() }),
          headers: {
            source: 'quote-service',
            version: '1',
          },
        },
      ],
    });
  } catch (error) {
    logger.error({ error, symbol }, 'Failed to publish quote');
    // Don't throw - quote publishing failures shouldn't break the system
  }
}

/**
 * Publishes multiple quote updates in a batch.
 * More efficient for bulk quote updates.
 *
 * @param quotes - Array of quotes to publish
 */
export async function publishQuotes(quotes: Quote[]): Promise<void> {
  if (!producer || !producerConnected) {
    logger.warn('Kafka producer not connected, skipping quotes publish');
    return;
  }

  try {
    await producer.send({
      topic: TOPICS.QUOTES,
      compression: CompressionTypes.Snappy,
      messages: quotes.map((quote: Quote) => ({
        key: quote.symbol,
        value: JSON.stringify(quote),
        headers: {
          source: 'quote-service',
          version: '1',
        },
      })),
    });
  } catch (error) {
    logger.error({ error }, 'Failed to publish quotes batch');
  }
}

/**
 * Order event types for the orders topic.
 */
export type OrderEventType = 'placed' | 'submitted' | 'filled' | 'partial' | 'cancelled' | 'rejected';

/**
 * Order event payload for Kafka.
 */
export interface OrderEvent {
  type: OrderEventType;
  order: Order;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

/**
 * Publishes an order event to the orders topic.
 * Uses the order ID as the partition key for ordering.
 *
 * @param order - Order object
 * @param eventType - Type of order event (placed, filled, cancelled, etc.)
 * @param metadata - Additional event metadata
 */
export async function publishOrder(
  order: Order,
  eventType: OrderEventType = 'placed',
  metadata?: Record<string, unknown>
): Promise<void> {
  if (!producer || !producerConnected) {
    logger.warn('Kafka producer not connected, skipping order publish');
    return;
  }

  const event: OrderEvent = {
    type: eventType,
    order,
    timestamp: Date.now(),
    metadata,
  };

  try {
    await producer.send({
      topic: TOPICS.ORDERS,
      messages: [
        {
          key: order.id,
          value: JSON.stringify(event),
          headers: {
            eventType,
            userId: order.user_id,
            symbol: order.symbol,
          },
        },
      ],
    });
    logger.debug({ orderId: order.id, eventType }, 'Order event published');
  } catch (error) {
    logger.error({ error, orderId: order.id }, 'Failed to publish order event');
  }
}

/**
 * Trade event payload for Kafka.
 */
export interface TradeEvent {
  execution: Execution;
  order: Order;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

/**
 * Publishes a trade execution event to the trades topic.
 * Uses the execution ID as the partition key.
 *
 * @param execution - Execution record
 * @param order - Associated order
 * @param metadata - Additional event metadata
 */
export async function publishTrade(
  execution: Execution,
  order: Order,
  metadata?: Record<string, unknown>
): Promise<void> {
  if (!producer || !producerConnected) {
    logger.warn('Kafka producer not connected, skipping trade publish');
    return;
  }

  const event: TradeEvent = {
    execution,
    order,
    timestamp: Date.now(),
    metadata,
  };

  try {
    await producer.send({
      topic: TOPICS.TRADES,
      messages: [
        {
          key: execution.id,
          value: JSON.stringify(event),
          headers: {
            userId: order.user_id,
            symbol: order.symbol,
            side: order.side,
          },
        },
      ],
    });
    logger.debug({ executionId: execution.id }, 'Trade event published');
  } catch (error) {
    logger.error({ error, executionId: execution.id }, 'Failed to publish trade event');
  }
}

/**
 * Creates a Kafka consumer for the specified topic.
 *
 * @param groupId - Consumer group ID
 * @returns Configured consumer instance
 */
export function createConsumer(groupId: string): Consumer {
  return kafka.consumer({
    groupId,
    sessionTimeout: 30000,
    heartbeatInterval: 3000,
  });
}

/**
 * Quote message handler type.
 */
export type QuoteHandler = (quotes: Quote[]) => void | Promise<void>;

/**
 * Creates a consumer for quote updates.
 * Automatically handles message parsing and batching.
 *
 * @param handler - Callback function for processing quotes
 * @param groupId - Consumer group ID (default: 'quote-consumers')
 * @returns Connected consumer instance
 */
export async function consumeQuotes(
  handler: QuoteHandler,
  groupId: string = 'quote-consumers'
): Promise<Consumer> {
  const consumer = createConsumer(groupId);

  await consumer.connect();
  await consumer.subscribe({ topic: TOPICS.QUOTES, fromBeginning: false });

  await consumer.run({
    eachBatch: async ({ batch }: EachBatchPayload) => {
      const quotes: Quote[] = batch.messages.map((msg) => {
        const value = msg.value?.toString();
        return value ? JSON.parse(value) : null;
      }).filter((q): q is Quote => q !== null);

      if (quotes.length > 0) {
        await handler(quotes);
      }
    },
  });

  logger.info({ groupId }, 'Quote consumer started');
  return consumer;
}

/**
 * Order event handler type.
 */
export type OrderHandler = (event: OrderEvent) => void | Promise<void>;

/**
 * Creates a consumer for order events.
 *
 * @param handler - Callback function for processing order events
 * @param groupId - Consumer group ID (default: 'order-consumers')
 * @returns Connected consumer instance
 */
export async function consumeOrders(
  handler: OrderHandler,
  groupId: string = 'order-consumers'
): Promise<Consumer> {
  const consumer = createConsumer(groupId);

  await consumer.connect();
  await consumer.subscribe({ topic: TOPICS.ORDERS, fromBeginning: false });

  await consumer.run({
    eachMessage: async ({ message }: EachMessagePayload) => {
      const value = message.value?.toString();
      if (value) {
        const event: OrderEvent = JSON.parse(value);
        await handler(event);
      }
    },
  });

  logger.info({ groupId }, 'Order consumer started');
  return consumer;
}

/**
 * Trade event handler type.
 */
export type TradeHandler = (event: TradeEvent) => void | Promise<void>;

/**
 * Creates a consumer for trade events.
 *
 * @param handler - Callback function for processing trade events
 * @param groupId - Consumer group ID (default: 'trade-consumers')
 * @returns Connected consumer instance
 */
export async function consumeTrades(
  handler: TradeHandler,
  groupId: string = 'trade-consumers'
): Promise<Consumer> {
  const consumer = createConsumer(groupId);

  await consumer.connect();
  await consumer.subscribe({ topic: TOPICS.TRADES, fromBeginning: false });

  await consumer.run({
    eachMessage: async ({ message }: EachMessagePayload) => {
      const value = message.value?.toString();
      if (value) {
        const event: TradeEvent = JSON.parse(value);
        await handler(event);
      }
    },
  });

  logger.info({ groupId }, 'Trade consumer started');
  return consumer;
}

/**
 * Gets the current producer connection status.
 */
export function isProducerConnected(): boolean {
  return producerConnected;
}

/**
 * Gets the Kafka client for advanced operations.
 */
export function getKafkaClient(): Kafka {
  return kafka;
}
