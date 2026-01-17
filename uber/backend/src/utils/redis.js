import Redis from 'ioredis';
import config from '../config/index.js';

const redis = new Redis(config.redis.url);

redis.on('error', (err) => {
  console.error('Redis error:', err);
});

redis.on('connect', () => {
  console.log('Connected to Redis');
});

export default redis;
