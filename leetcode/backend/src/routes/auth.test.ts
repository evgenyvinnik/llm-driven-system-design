import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import session from 'express-session';
import request from 'supertest';

// Mock dependencies before importing routes
vi.mock('../db/pool.js', () => ({
  default: {
    query: vi.fn(),
  },
}));

vi.mock('../shared/rateLimiter.js', () => ({
  authRateLimiter: vi.fn((_req, _res, next) => next()),
}));

import authRouter from './auth.js';
import pool from '../db/pool.js';

const mockPool = pool as unknown as { query: ReturnType<typeof vi.fn> };

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(
    session({
      secret: 'test-secret',
      resave: false,
      saveUninitialized: false,
    })
  );
  app.use('/auth', authRouter);
  return app;
}

describe('Auth Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('POST /auth/register', () => {
    it('should register a new user successfully', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] }); // No existing user
      mockPool.query.mockResolvedValueOnce({ rows: [] }); // Insert user

      const app = createApp();
      const response = await request(app).post('/auth/register').send({
        username: 'testuser',
        email: 'test@example.com',
        password: 'password123',
      });

      expect(response.status).toBe(201);
      expect(response.body.user).toBeDefined();
      expect(response.body.user.username).toBe('testuser');
      expect(response.body.user.email).toBe('test@example.com');
      expect(response.body.user.role).toBe('user');
    });

    it('should reject registration with missing username', async () => {
      const app = createApp();
      const response = await request(app).post('/auth/register').send({
        email: 'test@example.com',
        password: 'password123',
      });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Username, email, and password are required');
    });

    it('should reject registration with missing email', async () => {
      const app = createApp();
      const response = await request(app).post('/auth/register').send({
        username: 'testuser',
        password: 'password123',
      });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Username, email, and password are required');
    });

    it('should reject registration with missing password', async () => {
      const app = createApp();
      const response = await request(app).post('/auth/register').send({
        username: 'testuser',
        email: 'test@example.com',
      });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Username, email, and password are required');
    });

    it('should reject registration with short password', async () => {
      const app = createApp();
      const response = await request(app).post('/auth/register').send({
        username: 'testuser',
        email: 'test@example.com',
        password: '12345',
      });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Password must be at least 6 characters');
    });

    it('should reject registration with existing username', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'existing-id' }] });

      const app = createApp();
      const response = await request(app).post('/auth/register').send({
        username: 'existinguser',
        email: 'new@example.com',
        password: 'password123',
      });

      expect(response.status).toBe(409);
      expect(response.body.error).toBe('Username or email already exists');
    });
  });

  describe('POST /auth/login', () => {
    it('should login successfully with valid credentials', async () => {
      const bcrypt = await import('bcryptjs');
      const passwordHash = await bcrypt.hash('password123', 10);

      mockPool.query.mockResolvedValueOnce({
        rows: [
          {
            id: 'user-id',
            username: 'testuser',
            email: 'test@example.com',
            password_hash: passwordHash,
            role: 'user',
          },
        ],
      });

      const app = createApp();
      const response = await request(app).post('/auth/login').send({
        username: 'testuser',
        password: 'password123',
      });

      expect(response.status).toBe(200);
      expect(response.body.user).toBeDefined();
      expect(response.body.user.username).toBe('testuser');
    });

    it('should reject login with missing username', async () => {
      const app = createApp();
      const response = await request(app).post('/auth/login').send({
        password: 'password123',
      });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Username and password are required');
    });

    it('should reject login with missing password', async () => {
      const app = createApp();
      const response = await request(app).post('/auth/login').send({
        username: 'testuser',
      });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Username and password are required');
    });

    it('should reject login with non-existent user', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      const app = createApp();
      const response = await request(app).post('/auth/login').send({
        username: 'nonexistent',
        password: 'password123',
      });

      expect(response.status).toBe(401);
      expect(response.body.error).toBe('Invalid credentials');
    });

    it('should reject login with wrong password', async () => {
      const bcrypt = await import('bcryptjs');
      const passwordHash = await bcrypt.hash('correctpassword', 10);

      mockPool.query.mockResolvedValueOnce({
        rows: [
          {
            id: 'user-id',
            username: 'testuser',
            email: 'test@example.com',
            password_hash: passwordHash,
            role: 'user',
          },
        ],
      });

      const app = createApp();
      const response = await request(app).post('/auth/login').send({
        username: 'testuser',
        password: 'wrongpassword',
      });

      expect(response.status).toBe(401);
      expect(response.body.error).toBe('Invalid credentials');
    });
  });

  describe('POST /auth/logout', () => {
    it('should logout successfully', async () => {
      const app = createApp();
      const response = await request(app).post('/auth/logout');

      expect(response.status).toBe(200);
      expect(response.body.message).toBe('Logged out successfully');
    });
  });

  describe('GET /auth/me', () => {
    it('should return 401 when not authenticated', async () => {
      const app = createApp();
      const response = await request(app).get('/auth/me');

      expect(response.status).toBe(401);
      expect(response.body.error).toBe('Not authenticated');
    });
  });
});
