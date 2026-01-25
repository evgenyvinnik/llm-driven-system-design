import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import session from 'express-session';
import request from 'supertest';

// Mock redis before importing
vi.mock('../db/redis.js', () => ({
  default: {
    get: vi.fn(),
    setex: vi.fn(),
  },
}));

import {
  generateIdempotencyKey,
  checkDuplicate,
  storeSubmission,
  submissionIdempotency,
  IDEMPOTENCY_TTL,
} from './idempotency.js';
import redis from '../db/redis.js';

const mockRedis = redis as unknown as {
  get: ReturnType<typeof vi.fn>;
  setex: ReturnType<typeof vi.fn>;
};

describe('Idempotency Module', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('generateIdempotencyKey', () => {
    it('should generate consistent hash for same inputs', () => {
      const key1 = generateIdempotencyKey('user1', 'two-sum', 'def solve(): pass', 'python');
      const key2 = generateIdempotencyKey('user1', 'two-sum', 'def solve(): pass', 'python');
      expect(key1).toBe(key2);
    });

    it('should generate different hash for different users', () => {
      const key1 = generateIdempotencyKey('user1', 'two-sum', 'def solve(): pass', 'python');
      const key2 = generateIdempotencyKey('user2', 'two-sum', 'def solve(): pass', 'python');
      expect(key1).not.toBe(key2);
    });

    it('should generate different hash for different problems', () => {
      const key1 = generateIdempotencyKey('user1', 'two-sum', 'def solve(): pass', 'python');
      const key2 = generateIdempotencyKey('user1', 'reverse-string', 'def solve(): pass', 'python');
      expect(key1).not.toBe(key2);
    });

    it('should generate different hash for different code', () => {
      const key1 = generateIdempotencyKey('user1', 'two-sum', 'def solve(): pass', 'python');
      const key2 = generateIdempotencyKey('user1', 'two-sum', 'def solve(): return 1', 'python');
      expect(key1).not.toBe(key2);
    });

    it('should generate different hash for different languages', () => {
      const key1 = generateIdempotencyKey('user1', 'two-sum', 'function solve() {}', 'python');
      const key2 = generateIdempotencyKey('user1', 'two-sum', 'function solve() {}', 'javascript');
      expect(key1).not.toBe(key2);
    });

    it('should normalize trailing whitespace in code', () => {
      const key1 = generateIdempotencyKey('user1', 'two-sum', 'def solve(): pass  ', 'python');
      const key2 = generateIdempotencyKey('user1', 'two-sum', 'def solve(): pass', 'python');
      expect(key1).toBe(key2);
    });

    it('should normalize line endings', () => {
      const key1 = generateIdempotencyKey('user1', 'two-sum', 'line1\r\nline2', 'python');
      const key2 = generateIdempotencyKey('user1', 'two-sum', 'line1\nline2', 'python');
      expect(key1).toBe(key2);
    });
  });

  describe('checkDuplicate', () => {
    it('should return null when no duplicate exists', async () => {
      mockRedis.get.mockResolvedValueOnce(null);

      const result = await checkDuplicate('user1', 'two-sum', 'def solve(): pass', 'python');
      expect(result).toBeNull();
    });

    it('should return existing submission ID when duplicate exists', async () => {
      mockRedis.get.mockResolvedValueOnce('existing-submission-id');

      const result = await checkDuplicate('user1', 'two-sum', 'def solve(): pass', 'python');
      expect(result).toBe('existing-submission-id');
    });

    it('should return null on Redis error (fail open)', async () => {
      mockRedis.get.mockRejectedValueOnce(new Error('Redis connection error'));

      const result = await checkDuplicate('user1', 'two-sum', 'def solve(): pass', 'python');
      expect(result).toBeNull();
    });
  });

  describe('storeSubmission', () => {
    it('should store submission with correct TTL', async () => {
      mockRedis.setex.mockResolvedValueOnce('OK');

      await storeSubmission('user1', 'two-sum', 'def solve(): pass', 'python', 'submission-id');

      expect(mockRedis.setex).toHaveBeenCalledWith(
        expect.stringContaining('idempotency:submission:'),
        IDEMPOTENCY_TTL,
        'submission-id'
      );
    });

    it('should not throw on Redis error', async () => {
      mockRedis.setex.mockRejectedValueOnce(new Error('Redis connection error'));

      // Should not throw
      await expect(
        storeSubmission('user1', 'two-sum', 'def solve(): pass', 'python', 'submission-id')
      ).resolves.toBeUndefined();
    });
  });

  describe('submissionIdempotency middleware', () => {
    function createApp() {
      const app = express();
      app.use(express.json());
      app.use(
        session({
          secret: 'test-secret',
          resave: false,
          saveUninitialized: true,
        })
      );

      // Middleware to set session userId
      app.use((req, _res, next) => {
        req.session.userId = 'test-user-id';
        next();
      });

      app.post('/submit', submissionIdempotency(), (req, res) => {
        res.json({ submissionId: 'new-submission-id', status: 'pending' });
      });

      return app;
    }

    it('should return duplicate response when submission already exists', async () => {
      mockRedis.get.mockResolvedValueOnce('existing-submission-id');

      const app = createApp();
      const response = await request(app).post('/submit').send({
        problemSlug: 'two-sum',
        language: 'python',
        code: 'def solve(): pass',
      });

      expect(response.status).toBe(200);
      expect(response.body.submissionId).toBe('existing-submission-id');
      expect(response.body.status).toBe('duplicate');
    });

    it('should proceed when no duplicate exists', async () => {
      mockRedis.get.mockResolvedValueOnce(null);

      const app = createApp();
      const response = await request(app).post('/submit').send({
        problemSlug: 'two-sum',
        language: 'python',
        code: 'def solve(): pass',
      });

      expect(response.status).toBe(200);
      expect(response.body.submissionId).toBe('new-submission-id');
      expect(response.body.status).toBe('pending');
    });

    it('should proceed when required fields are missing', async () => {
      const app = createApp();
      const response = await request(app).post('/submit').send({
        problemSlug: 'two-sum',
        // Missing language and code
      });

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('pending');
    });
  });
});
