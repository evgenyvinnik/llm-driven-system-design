const Redis = require('ioredis');
const config = require('../config');

const redis = new Redis(config.redis.url);

redis.on('error', (err) => {
  console.error('Redis connection error:', err);
});

redis.on('connect', () => {
  console.log('Connected to Redis');
});

module.exports = redis;
