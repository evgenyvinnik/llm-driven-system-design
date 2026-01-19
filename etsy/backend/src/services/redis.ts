import RedisClient from 'ioredis';
import config from '../config.js';

const Redis = RedisClient.default || RedisClient;
const redis = new Redis(config.redis.url);

redis.on('error', (err: Error) => {
  console.error('Redis error:', err);
});

redis.on('connect', () => {
  console.log('Connected to Redis');
});

export default redis;
