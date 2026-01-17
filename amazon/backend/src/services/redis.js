import { createClient } from 'redis';

let client = null;

export async function initializeRedis() {
  client = createClient({
    url: process.env.REDIS_URL || 'redis://localhost:6379'
  });

  client.on('error', (err) => console.error('Redis Client Error', err));
  client.on('connect', () => console.log('Redis connected'));

  await client.connect();
  return client;
}

export function getRedis() {
  if (!client) {
    throw new Error('Redis not initialized');
  }
  return client;
}

// Session helpers
export async function setSession(sessionId, data, expiresInSeconds = 86400) {
  await client.set(`session:${sessionId}`, JSON.stringify(data), {
    EX: expiresInSeconds
  });
}

export async function getSession(sessionId) {
  const data = await client.get(`session:${sessionId}`);
  return data ? JSON.parse(data) : null;
}

export async function deleteSession(sessionId) {
  await client.del(`session:${sessionId}`);
}

// Cache helpers
export async function cacheGet(key) {
  const data = await client.get(key);
  return data ? JSON.parse(data) : null;
}

export async function cacheSet(key, value, expiresInSeconds = 3600) {
  await client.set(key, JSON.stringify(value), {
    EX: expiresInSeconds
  });
}

export async function cacheDel(key) {
  await client.del(key);
}

// Recommendations
export async function getRecommendations(productId) {
  const data = await client.get(`recs:${productId}`);
  return data ? JSON.parse(data) : null;
}

export async function setRecommendations(productId, recommendations, expiresInSeconds = 86400) {
  await client.set(`recs:${productId}`, JSON.stringify(recommendations), {
    EX: expiresInSeconds
  });
}
