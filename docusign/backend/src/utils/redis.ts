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
export async function setSession(token: string, userId: string, expiresInSeconds: number = 86400): Promise<void> {
  await redisClient.setEx(`session:${token}`, expiresInSeconds, userId);
}

export async function getSession(token: string): Promise<string | null> {
  return await redisClient.get(`session:${token}`);
}

export async function deleteSession(token: string): Promise<void> {
  await redisClient.del(`session:${token}`);
}

// Signing session helpers
export async function setSigningSession(token: string, data: unknown, expiresInSeconds: number = 3600): Promise<void> {
  await redisClient.setEx(`signing:${token}`, expiresInSeconds, JSON.stringify(data));
}

export async function getSigningSession(token: string): Promise<unknown> {
  const data = await redisClient.get(`signing:${token}`);
  return data ? JSON.parse(data) : null;
}

// SMS verification codes
export async function setSMSCode(recipientId: string, code: string, expiresInSeconds: number = 300): Promise<void> {
  await redisClient.setEx(`sms_code:${recipientId}`, expiresInSeconds, code);
}

export async function getSMSCode(recipientId: string): Promise<string | null> {
  return await redisClient.get(`sms_code:${recipientId}`);
}

export async function deleteSMSCode(recipientId: string): Promise<void> {
  await redisClient.del(`sms_code:${recipientId}`);
}
