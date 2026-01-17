import express from 'express';
import { authenticate } from '../middleware/auth.js';
import {
  login,
  register,
  logout,
  getCurrentUser,
} from '../middleware/auth.js';

const router = express.Router();

// Register new user
router.post('/register', register);

// Login
router.post('/login', login);

// Logout
router.post('/logout', logout);

// Get current user
router.get('/me', authenticate, getCurrentUser);

export default router;
