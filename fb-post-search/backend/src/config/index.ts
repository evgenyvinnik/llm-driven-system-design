/**
 * @fileoverview Application configuration module that validates and exports environment variables.
 * Uses Zod for runtime validation to ensure all required config values are present and correctly typed.
 * This centralized config approach prevents scattered process.env access throughout the codebase.
 */

import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

/**
 * Zod schema defining the expected environment variables and their defaults.
 * Validates all required configuration at startup to fail fast if misconfigured.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().default('3000'),

  // PostgreSQL
  POSTGRES_HOST: z.string().default('localhost'),
  POSTGRES_PORT: z.string().default('5432'),
  POSTGRES_USER: z.string().default('fb_search'),
  POSTGRES_PASSWORD: z.string().default('fb_search_password'),
  POSTGRES_DB: z.string().default('fb_post_search'),

  // Elasticsearch
  ELASTICSEARCH_URL: z.string().default('http://localhost:9200'),
  ELASTICSEARCH_INDEX: z.string().default('posts'),

  // Redis
  REDIS_URL: z.string().default('redis://localhost:6379'),

  // Session
  SESSION_SECRET: z.string().default('dev-secret-change-me'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment variables:', parsed.error.format());
  process.exit(1);
}

/**
 * Validated application configuration object.
 * Provides typed access to all environment-based settings including database connections,
 * Elasticsearch, Redis, and session configuration.
 * @constant
 */
export const config = {
  env: parsed.data.NODE_ENV,
  port: parseInt(parsed.data.PORT, 10),

  postgres: {
    host: parsed.data.POSTGRES_HOST,
    port: parseInt(parsed.data.POSTGRES_PORT, 10),
    user: parsed.data.POSTGRES_USER,
    password: parsed.data.POSTGRES_PASSWORD,
    database: parsed.data.POSTGRES_DB,
  },

  elasticsearch: {
    url: parsed.data.ELASTICSEARCH_URL,
    index: parsed.data.ELASTICSEARCH_INDEX,
  },

  redis: {
    url: parsed.data.REDIS_URL,
  },

  session: {
    secret: parsed.data.SESSION_SECRET,
  },
};
