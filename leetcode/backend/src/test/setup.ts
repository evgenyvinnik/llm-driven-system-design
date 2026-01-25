import { vi } from 'vitest';

// Mock environment variables
process.env.SESSION_SECRET = 'test-secret';
process.env.NODE_ENV = 'test';

// Mock pino logger to reduce noise in tests
vi.mock('../shared/logger.js', () => ({
  default: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => ({
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    })),
  },
  createModuleLogger: vi.fn(() => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  })),
  requestLogger: vi.fn((_req, _res, next) => next()),
}));
