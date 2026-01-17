import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { UserService } from '../services/userService.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
const userService = new UserService();

// Ensure uploads directory exists
const uploadsDir = path.join(process.cwd(), 'uploads', 'photos');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Configure multer for photo uploads
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (_req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: (_req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type'));
    }
  },
});

// Get user profile
router.get('/profile', requireAuth, async (req: Request, res: Response) => {
  try {
    const profile = await userService.getUserProfile(req.session.userId!);
    if (!profile) {
      res.status(404).json({ error: 'Profile not found' });
      return;
    }

    const { password_hash, ...safeProfile } = profile;
    res.json(safeProfile);
  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({ error: 'Failed to get profile' });
  }
});

// Update user profile
router.put('/profile', requireAuth, async (req: Request, res: Response) => {
  try {
    const { name, bio, job_title, company, school } = req.body;

    const updatedUser = await userService.updateUser(req.session.userId!, {
      name,
      bio,
      job_title,
      company,
      school,
    });

    if (!updatedUser) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const { password_hash, ...safeUser } = updatedUser;
    res.json(safeUser);
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// Update location
router.put('/location', requireAuth, async (req: Request, res: Response) => {
  try {
    const { latitude, longitude } = req.body;

    if (typeof latitude !== 'number' || typeof longitude !== 'number') {
      res.status(400).json({ error: 'Invalid coordinates' });
      return;
    }

    if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
      res.status(400).json({ error: 'Coordinates out of range' });
      return;
    }

    await userService.updateLocation(req.session.userId!, latitude, longitude);
    res.json({ message: 'Location updated' });
  } catch (error) {
    console.error('Update location error:', error);
    res.status(500).json({ error: 'Failed to update location' });
  }
});

// Get preferences
router.get('/preferences', requireAuth, async (req: Request, res: Response) => {
  try {
    const preferences = await userService.getPreferences(req.session.userId!);
    if (!preferences) {
      res.status(404).json({ error: 'Preferences not found' });
      return;
    }
    res.json(preferences);
  } catch (error) {
    console.error('Get preferences error:', error);
    res.status(500).json({ error: 'Failed to get preferences' });
  }
});

// Update preferences
router.put('/preferences', requireAuth, async (req: Request, res: Response) => {
  try {
    const { interested_in, age_min, age_max, distance_km, show_me } = req.body;

    const updates: Record<string, unknown> = {};

    if (interested_in !== undefined) {
      if (!Array.isArray(interested_in)) {
        res.status(400).json({ error: 'interested_in must be an array' });
        return;
      }
      updates.interested_in = interested_in;
    }

    if (age_min !== undefined) {
      if (typeof age_min !== 'number' || age_min < 18) {
        res.status(400).json({ error: 'age_min must be at least 18' });
        return;
      }
      updates.age_min = age_min;
    }

    if (age_max !== undefined) {
      if (typeof age_max !== 'number' || age_max < 18) {
        res.status(400).json({ error: 'age_max must be at least 18' });
        return;
      }
      updates.age_max = age_max;
    }

    if (distance_km !== undefined) {
      if (typeof distance_km !== 'number' || distance_km < 1 || distance_km > 500) {
        res.status(400).json({ error: 'distance_km must be between 1 and 500' });
        return;
      }
      updates.distance_km = distance_km;
    }

    if (show_me !== undefined) {
      updates.show_me = Boolean(show_me);
    }

    const preferences = await userService.updatePreferences(req.session.userId!, updates);
    res.json(preferences);
  } catch (error) {
    console.error('Update preferences error:', error);
    res.status(500).json({ error: 'Failed to update preferences' });
  }
});

// Get photos
router.get('/photos', requireAuth, async (req: Request, res: Response) => {
  try {
    const photos = await userService.getPhotos(req.session.userId!);
    res.json(photos);
  } catch (error) {
    console.error('Get photos error:', error);
    res.status(500).json({ error: 'Failed to get photos' });
  }
});

// Upload photo
router.post(
  '/photos',
  requireAuth,
  upload.single('photo'),
  async (req: Request, res: Response) => {
    try {
      if (!req.file) {
        res.status(400).json({ error: 'No file uploaded' });
        return;
      }

      const existingPhotos = await userService.getPhotos(req.session.userId!);
      if (existingPhotos.length >= 6) {
        // Delete uploaded file
        fs.unlinkSync(req.file.path);
        res.status(400).json({ error: 'Maximum 6 photos allowed' });
        return;
      }

      const position = parseInt(req.body.position) || existingPhotos.length;
      const url = `/uploads/photos/${req.file.filename}`;

      const photo = await userService.addPhoto(req.session.userId!, url, position);
      res.status(201).json(photo);
    } catch (error) {
      console.error('Upload photo error:', error);
      res.status(500).json({ error: 'Failed to upload photo' });
    }
  }
);

// Delete photo
router.delete('/photos/:photoId', requireAuth, async (req: Request, res: Response) => {
  try {
    const { photoId } = req.params;
    const deleted = await userService.deletePhoto(req.session.userId!, photoId);

    if (!deleted) {
      res.status(404).json({ error: 'Photo not found' });
      return;
    }

    res.json({ message: 'Photo deleted' });
  } catch (error) {
    console.error('Delete photo error:', error);
    res.status(500).json({ error: 'Failed to delete photo' });
  }
});

export default router;
