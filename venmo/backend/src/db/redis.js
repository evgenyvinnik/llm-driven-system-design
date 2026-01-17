const Redis = require('ioredis');
require('dotenv').config();

const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
});

// Session management
const SESSION_PREFIX = 'session:';
const SESSION_TTL = 24 * 60 * 60; // 24 hours

const setSession = async (sessionId, userId) => {
  await redis.set(`${SESSION_PREFIX}${sessionId}`, userId, 'EX', SESSION_TTL);
};

const getSession = async (sessionId) => {
  return await redis.get(`${SESSION_PREFIX}${sessionId}`);
};

const deleteSession = async (sessionId) => {
  await redis.del(`${SESSION_PREFIX}${sessionId}`);
};

// Balance cache
const BALANCE_PREFIX = 'balance:';
const BALANCE_TTL = 60; // 1 minute

const getCachedBalance = async (userId) => {
  const cached = await redis.get(`${BALANCE_PREFIX}${userId}`);
  return cached ? parseInt(cached) : null;
};

const setCachedBalance = async (userId, balance) => {
  await redis.set(`${BALANCE_PREFIX}${userId}`, balance, 'EX', BALANCE_TTL);
};

const invalidateBalanceCache = async (userId) => {
  await redis.del(`${BALANCE_PREFIX}${userId}`);
};

module.exports = {
  redis,
  setSession,
  getSession,
  deleteSession,
  getCachedBalance,
  setCachedBalance,
  invalidateBalanceCache,
};
