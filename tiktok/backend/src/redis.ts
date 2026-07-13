import { createClient, RedisClientType } from 'redis';
import dotenv from 'dotenv';

dotenv.config();

const client: RedisClientType = createClient({
  url: process.env.REDIS_URL || 'redis://localhost:6379',
});

client.on('error', (err: Error) => console.error('Redis Client Error', err));

let isConnected = false;

/** Connects to Redis if not already connected and returns the client. */
export const connectRedis = async (): Promise<RedisClientType> => {
  if (!isConnected) {
    await client.connect();
    isConnected = true;
    console.log('Connected to Redis');
  }
  return client;
};

/** Returns the Redis client instance (may not be connected). */
export const getRedis = (): RedisClientType => client;

export default client;
