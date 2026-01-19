import Redis from 'ioredis';
import config from '../config/index.js';

const redis: Redis = new Redis(config.redis.url);

redis.on('error', (err: Error): void => {
  console.error('Redis error:', err);
});

redis.on('connect', (): void => {
  console.log('Connected to Redis');
});

export default redis;
