import { createClient, type RedisClientType } from 'redis';

const redisClient: RedisClientType = createClient({
  url: process.env.REDIS_URL || 'redis://localhost:6379',
});

redisClient.on('error', (err) => console.error('Redis Client Error', err));
redisClient.on('connect', () => console.log('Connected to Redis'));

export const connectRedis = async (): Promise<RedisClientType> => {
  if (!redisClient.isOpen) {
    await redisClient.connect();
  }
  return redisClient;
};

export default redisClient;
