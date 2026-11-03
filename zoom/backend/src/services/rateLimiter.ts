import rateLimit from 'express-rate-limit';
import { config } from '../config/index.js';

/** General API rate limiter: 100 requests per 15 minutes by default (API_RATE_LIMIT). */
export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: config.rateLimit.apiPerWindow,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' },
});

/**
 * Authentication rate limiter: 20 failed attempts per 15 minutes. Only failures
 * count — it exists to slow password guessing, not to lock out a user who signs
 * in and out normally.
 */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: config.rateLimit.authFailuresPerWindow,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many auth attempts, please try again later' },
});
