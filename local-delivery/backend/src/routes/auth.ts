import { Router } from 'express';
import type { Request, Response } from 'express';
import {
  createUser,
  validatePassword,
  createSession,
  deleteSession,
  getUserById,
  updateUser,
  changePassword,
} from '../services/authService.js';
import { createDriver } from '../services/driverService.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();

// Register new user
router.post('/register', async (req: Request, res: Response) => {
  try {
    const { email, password, name, phone, role, vehicle_type, license_plate } = req.body;

    if (!email || !password || !name || !role) {
      res.status(400).json({
        success: false,
        error: 'Email, password, name, and role are required',
      });
      return;
    }

    if (!['customer', 'driver', 'merchant'].includes(role)) {
      res.status(400).json({
        success: false,
        error: 'Role must be customer, driver, or merchant',
      });
      return;
    }

    // Create user
    const user = await createUser({ email, password, name, phone, role });

    // If driver, create driver profile
    if (role === 'driver') {
      if (!vehicle_type) {
        res.status(400).json({
          success: false,
          error: 'Vehicle type is required for drivers',
        });
        return;
      }

      await createDriver({
        user_id: user.id,
        vehicle_type,
        license_plate,
      });
    }

    // Create session
    const session = await createSession(user.id);

    res.status(201).json({
      success: true,
      data: {
        user,
        token: session.token,
        expires_at: session.expires_at,
      },
    });
  } catch (error) {
    console.error('Registration error:', error);

    if ((error as Error).message?.includes('duplicate key')) {
      res.status(409).json({
        success: false,
        error: 'Email already registered',
      });
      return;
    }

    res.status(500).json({
      success: false,
      error: 'Registration failed',
    });
  }
});

// Login
router.post('/login', async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      res.status(400).json({
        success: false,
        error: 'Email and password are required',
      });
      return;
    }

    const user = await validatePassword(email, password);

    if (!user) {
      res.status(401).json({
        success: false,
        error: 'Invalid email or password',
      });
      return;
    }

    const session = await createSession(user.id);

    res.json({
      success: true,
      data: {
        user,
        token: session.token,
        expires_at: session.expires_at,
      },
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({
      success: false,
      error: 'Login failed',
    });
  }
});

// Logout
router.post('/logout', authenticate, async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader?.substring(7);

    if (token) {
      await deleteSession(token);
    }

    res.json({
      success: true,
      message: 'Logged out successfully',
    });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({
      success: false,
      error: 'Logout failed',
    });
  }
});

// Get current user
router.get('/me', authenticate, async (req: Request, res: Response) => {
  try {
    const user = await getUserById(req.userId!);

    if (!user) {
      res.status(404).json({
        success: false,
        error: 'User not found',
      });
      return;
    }

    res.json({
      success: true,
      data: user,
    });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get user',
    });
  }
});

// Update current user
router.patch('/me', authenticate, async (req: Request, res: Response) => {
  try {
    const { name, phone } = req.body;

    const user = await updateUser(req.userId!, { name, phone });

    if (!user) {
      res.status(404).json({
        success: false,
        error: 'User not found',
      });
      return;
    }

    res.json({
      success: true,
      data: user,
    });
  } catch (error) {
    console.error('Update user error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update user',
    });
  }
});

// Change password
router.post('/change-password', authenticate, async (req: Request, res: Response) => {
  try {
    const { old_password, new_password } = req.body;

    if (!old_password || !new_password) {
      res.status(400).json({
        success: false,
        error: 'Old and new passwords are required',
      });
      return;
    }

    const success = await changePassword(req.userId!, old_password, new_password);

    if (!success) {
      res.status(400).json({
        success: false,
        error: 'Invalid old password',
      });
      return;
    }

    res.json({
      success: true,
      message: 'Password changed successfully',
    });
  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to change password',
    });
  }
});

export default router;
