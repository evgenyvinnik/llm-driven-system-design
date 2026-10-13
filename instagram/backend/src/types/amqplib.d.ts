/**
 * Type declarations for 'amqplib' module.
 * This provides minimal types for the RabbitMQ client.
 */
declare module 'amqplib' {
  import { EventEmitter } from 'events';

  export interface Options {
    durable?: boolean;
    exclusive?: boolean;
    autoDelete?: boolean;
    arguments?: Record<string, unknown>;
    noAck?: boolean;
  }

  export interface PublishOptions {
    persistent?: boolean;
    contentType?: string;
    contentEncoding?: string;
    headers?: Record<string, unknown>;
    deliveryMode?: number;
    priority?: number;
    correlationId?: string;
    replyTo?: string;
    expiration?: string;
    messageId?: string;
    timestamp?: number;
    type?: string;
    userId?: string;
    appId?: string;
  }

  export interface ConsumeMessage {
    content: Buffer;
    fields: {
      consumerTag: string;
      deliveryTag: number;
      redelivered: boolean;
      exchange: string;
      routingKey: string;
    };
    properties: {
      contentType?: string;
      contentEncoding?: string;
      headers?: Record<string, unknown>;
      deliveryMode?: number;
      priority?: number;
      correlationId?: string;
      replyTo?: string;
      expiration?: string;
      messageId?: string;
      timestamp?: number;
      type?: string;
      userId?: string;
      appId?: string;
    };
  }

  export interface Replies {
    queue: string;
    messageCount: number;
    consumerCount: number;
  }

  export interface Channel extends EventEmitter {
    close(): Promise<void>;
    assertQueue(queue: string, options?: Options): Promise<Replies>;
    assertExchange(exchange: string, type: string, options?: Options): Promise<{ exchange: string }>;
    bindQueue(queue: string, source: string, pattern: string, args?: Record<string, unknown>): Promise<void>;
    sendToQueue(queue: string, content: Buffer, options?: PublishOptions): boolean;
    consume(
      queue: string,
      onMessage: (msg: ConsumeMessage | null) => void,
      options?: { noAck?: boolean; consumerTag?: string; exclusive?: boolean; priority?: number }
    ): Promise<{ consumerTag: string }>;
    ack(message: ConsumeMessage, allUpTo?: boolean): void;
    nack(message: ConsumeMessage, allUpTo?: boolean, requeue?: boolean): void;
    prefetch(count: number, global?: boolean): Promise<void>;
    publish(exchange: string, routingKey: string, content: Buffer, options?: PublishOptions): boolean;
    cancel(consumerTag: string): Promise<void>;
    deleteQueue(queue: string, options?: { ifUnused?: boolean; ifEmpty?: boolean }): Promise<{ messageCount: number }>;
    deleteExchange(exchange: string, options?: { ifUnused?: boolean }): Promise<void>;
    unbindQueue(queue: string, source: string, pattern: string, args?: Record<string, unknown>): Promise<void>;
  }

  /** Channel in confirm mode: the broker acks (or nacks) every publish, reported via the callback. */
  export interface ConfirmChannel extends Channel {
    sendToQueue(
      queue: string,
      content: Buffer,
      options?: PublishOptions,
      callback?: (err: unknown, ok: unknown) => void
    ): boolean;
    publish(
      exchange: string,
      routingKey: string,
      content: Buffer,
      options?: PublishOptions,
      callback?: (err: unknown, ok: unknown) => void
    ): boolean;
    waitForConfirms(): Promise<void>;
  }

  export interface Connection extends EventEmitter {
    createChannel(): Promise<Channel>;
    createConfirmChannel(): Promise<ConfirmChannel>;
    close(): Promise<void>;
  }

  export function connect(url: string, socketOptions?: unknown): Promise<Connection>;

  const amqp: {
    connect: typeof connect;
  };

  export default amqp;
}
