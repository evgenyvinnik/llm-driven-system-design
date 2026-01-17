import { createClient } from 'redis';
import config from '../config/index.js';

const client = createClient({
  url: config.redis.url,
});

client.on('error', (err) => console.error('Redis Client Error', err));
client.on('connect', () => console.log('Connected to Redis'));

await client.connect();

// Session management
export async function setSession(sessionId, data, ttlSeconds = 86400) {
  await client.set(`session:${sessionId}`, JSON.stringify(data), {
    EX: ttlSeconds,
  });
}

export async function getSession(sessionId) {
  const data = await client.get(`session:${sessionId}`);
  return data ? JSON.parse(data) : null;
}

export async function deleteSession(sessionId) {
  await client.del(`session:${sessionId}`);
}

// Domain to store mapping cache
export async function setDomainMapping(domain, storeId, ttlSeconds = 3600) {
  await client.set(`domain:${domain}`, String(storeId), {
    EX: ttlSeconds,
  });
}

export async function getDomainMapping(domain) {
  const storeId = await client.get(`domain:${domain}`);
  return storeId ? parseInt(storeId, 10) : null;
}

// Cart management
export async function setCart(cartId, data, ttlSeconds = 604800) {
  await client.set(`cart:${cartId}`, JSON.stringify(data), {
    EX: ttlSeconds,
  });
}

export async function getCart(cartId) {
  const data = await client.get(`cart:${cartId}`);
  return data ? JSON.parse(data) : null;
}

export async function deleteCart(cartId) {
  await client.del(`cart:${cartId}`);
}

export default client;
