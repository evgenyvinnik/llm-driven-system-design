import { Router, Request, Response } from 'express';
import { authService } from '../services/auth.js';
import { AuthenticatedRequest, authMiddleware } from '../middleware/auth.js';
import { z } from 'zod';

const router = Router();

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  deviceId: z.string().uuid().optional(),
});

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  name: z.string().min(1),
});

const deviceSchema = z.object({
  deviceName: z.string().min(1),
  deviceType: z.enum(['iphone', 'apple_watch', 'ipad']),
});

// Login
router.post('/login', async (req: Request, res: Response) => {
  try {
    const data = loginSchema.parse(req.body);
    const result = await authService.login(data.email, data.password, data.deviceId);

    if (!result.success) {
      return res.status(401).json({ error: result.error });
    }

    res.json({
      sessionId: result.sessionId,
      user: result.user,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid input', details: error.errors });
    }
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Register
router.post('/register', async (req: Request, res: Response) => {
  try {
    const data = registerSchema.parse(req.body);
    const result = await authService.register(data.email, data.password, data.name);

    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }

    res.status(201).json({ user: result.user });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid input', details: error.errors });
    }
    console.error('Register error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Logout
router.post('/logout', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const sessionId = req.headers['x-session-id'] as string;
    await authService.logout(sessionId);
    res.json({ success: true });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get current user
router.get('/me', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const sessionId = req.headers['x-session-id'] as string;
    const user = await authService.getCurrentUser(sessionId);

    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }

    res.json({ user });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Register device
router.post('/devices', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const data = deviceSchema.parse(req.body);
    const device = await authService.registerDevice(
      req.userId!,
      data.deviceName,
      data.deviceType
    );
    res.status(201).json({ device });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid input', details: error.errors });
    }
    console.error('Register device error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get user's devices
router.get('/devices', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const devices = await authService.getDevices(req.userId!);
    res.json({ devices });
  } catch (error) {
    console.error('Get devices error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Remove device
router.delete('/devices/:deviceId', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await authService.removeDevice(req.userId!, req.params.deviceId);

    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Remove device error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Report device lost
router.post('/devices/:deviceId/lost', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await authService.reportDeviceLost(req.userId!, req.params.deviceId);

    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }

    res.json({
      success: true,
      suspendedCards: result.suspendedCards,
    });
  } catch (error) {
    console.error('Report device lost error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
