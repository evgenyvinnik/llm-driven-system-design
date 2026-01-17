import { createClient } from 'redis';

export const redisClient = createClient({
  url: process.env.REDIS_URL || 'redis://localhost:6379'
});

redisClient.on('error', (err) => {
  console.error('Redis error:', err);
});

export async function initializeRedis() {
  await redisClient.connect();
}

// Session management helpers
export async function setSession(token, userId, expiresInSeconds = 86400) {
  await redisClient.setEx(`session:${token}`, expiresInSeconds, userId);
}

export async function getSession(token) {
  return await redisClient.get(`session:${token}`);
}

export async function deleteSession(token) {
  await redisClient.del(`session:${token}`);
}

// Signing session helpers
export async function setSigningSession(token, data, expiresInSeconds = 3600) {
  await redisClient.setEx(`signing:${token}`, expiresInSeconds, JSON.stringify(data));
}

export async function getSigningSession(token) {
  const data = await redisClient.get(`signing:${token}`);
  return data ? JSON.parse(data) : null;
}

// SMS verification codes
export async function setSMSCode(recipientId, code, expiresInSeconds = 300) {
  await redisClient.setEx(`sms_code:${recipientId}`, expiresInSeconds, code);
}

export async function getSMSCode(recipientId) {
  return await redisClient.get(`sms_code:${recipientId}`);
}

export async function deleteSMSCode(recipientId) {
  await redisClient.del(`sms_code:${recipientId}`);
}
