const { createClient } = require('redis');
const config = require('../config');

const client = createClient({
  url: config.redis.url
});

client.on('error', (err) => {
  console.error('Redis client error:', err);
});

client.on('connect', () => {
  console.log('Connected to Redis');
});

const connect = async () => {
  await client.connect();
};

module.exports = {
  client,
  connect
};
