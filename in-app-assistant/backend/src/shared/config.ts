/**
 * Environment configuration shared by the API, indexer, and mock model.
 * Every value has a local-development default so `npm run dev` works with the
 * docker-compose stack and no .env file.
 * @module shared/config
 */

function int(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

const modelPort = int('MODEL_PORT', 3100)
/** A real API key switches the model client from the mock to Claude. */
const anthropicKey = process.env.ANTHROPIC_API_KEY || ''

export const config = {
  databaseUrl:
    process.env.DATABASE_URL || 'postgresql://assistant:assistant_password@localhost:5432/in_app_assistant',
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',

  apiPort: int('PORT', 3000),
  modelPort,
  indexerPort: int('INDEXER_PORT', 3200),
  instanceId: process.env.INSTANCE_ID || `api-${process.pid}`,

  sessionCookie: 'assistant_session',
  sessionTtlSeconds: int('SESSION_TTL_SECONDS', 7 * 24 * 60 * 60),
  /** Signs on-behalf-of tokens. Tools act with the user's identity, never a service account. */
  oboSecret: process.env.OBO_SECRET || 'local-dev-obo-secret-change-me',

  model: {
    provider: anthropicKey ? ('anthropic' as const) : ('mock' as const),
    apiKey: anthropicKey || 'mock-key',
    baseUrl: anthropicKey ? process.env.ANTHROPIC_BASE_URL || undefined : `http://localhost:${modelPort}`,
    primary: process.env.MODEL_PRIMARY || (anthropicKey ? 'claude-opus-5-5' : 'mock-assistant'),
    /** Used after the primary keeps failing with overload or server errors. */
    fallback: process.env.MODEL_FALLBACK || (anthropicKey ? 'claude-sonnet-5-5' : 'mock-assistant-fallback'),
    maxTokens: int('MODEL_MAX_TOKENS', anthropicKey ? 16000 : 1024),
    attemptsPerModel: int('MODEL_ATTEMPTS', 3),
  },

  turn: {
    maxStepsDefault: int('TURN_MAX_STEPS', 15),
    maxOutputTokens: int('TURN_MAX_OUTPUT_TOKENS', 20000),
    deadlineSeconds: int('TURN_DEADLINE_SECONDS', 120),
    /** Request size (estimated tokens) at which older tool results in the turn get trimmed. */
    contextBudgetTokens: int('TURN_CONTEXT_BUDGET', 12000),
    /** Share of the context budget earlier turns may use before they are summarized. */
    historyBudgetTokens: int('TURN_HISTORY_BUDGET', 4000),
    toolResultMaxTokens: int('TOOL_RESULT_MAX_TOKENS', 2000),
    leaseSeconds: int('TURN_LEASE_SECONDS', 30),
    heartbeatMs: int('TURN_HEARTBEAT_MS', 10000),
    sweepIntervalMs: int('TURN_SWEEP_INTERVAL_MS', 5000),
    clientToolTimeoutSeconds: int('CLIENT_TOOL_TIMEOUT_SECONDS', 30),
    confirmTimeoutSeconds: int('CONFIRM_TIMEOUT_SECONDS', 600),
    turnsPerMinutePerUser: int('TURNS_PER_MINUTE', 20),
  },

  index: {
    pollMs: int('INDEX_POLL_MS', 500),
    /** Content changes wait this long before indexing (simulated pipeline latency). Permission changes never wait. */
    contentDelayMs: int('INDEX_CONTENT_DELAY_MS', 3000),
    batchSize: int('INDEX_BATCH_SIZE', 20),
  },

  /** Live event streams are kept this long after a turn ends; readers then fall back to PostgreSQL. */
  eventStreamTtlSeconds: int('EVENT_STREAM_TTL_SECONDS', 3600),
}
