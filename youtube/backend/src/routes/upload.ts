import express from 'express';
import multer from 'multer';
import { authenticate } from '../middleware/auth.js';
import {
  initUpload,
  uploadChunk,
  completeUpload,
  cancelUpload,
  getUploadStatus,
} from '../services/upload.js';
import { getTranscodingStatus } from '../services/transcoding.js';
import config from '../config/index.js';

const router = express.Router();

// Configure multer for chunk uploads
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: {
    fileSize: config.upload.chunkSize + 1024 * 1024, // Chunk size + 1MB buffer
  },
});

// Initialize upload session
router.post('/init', authenticate, async (req, res) => {
  try {
    const { filename, fileSize, contentType } = req.body;

    if (!filename || !fileSize || !contentType) {
      return res.status(400).json({ error: 'Missing required fields: filename, fileSize, contentType' });
    }

    const result = await initUpload(req.user.id, filename, fileSize, contentType);
    res.json(result);
  } catch (error) {
    console.error('Upload init error:', error);
    res.status(400).json({ error: error.message });
  }
});

// Upload a chunk
router.put('/:uploadId/chunks/:chunkNumber', authenticate, upload.single('chunk'), async (req, res) => {
  try {
    const { uploadId, chunkNumber } = req.params;

    if (!req.file) {
      return res.status(400).json({ error: 'No chunk data provided' });
    }

    const result = await uploadChunk(uploadId, parseInt(chunkNumber, 10), req.file.buffer);
    res.json(result);
  } catch (error) {
    console.error('Chunk upload error:', error);
    res.status(400).json({ error: error.message });
  }
});

// Complete upload and start processing
router.post('/:uploadId/complete', authenticate, async (req, res) => {
  try {
    const { uploadId } = req.params;
    const { title, description, categories, tags } = req.body;

    if (!title) {
      return res.status(400).json({ error: 'Title is required' });
    }

    const result = await completeUpload(
      uploadId,
      req.user.id,
      title,
      description,
      categories || [],
      tags || []
    );

    res.json(result);
  } catch (error) {
    console.error('Complete upload error:', error);
    res.status(400).json({ error: error.message });
  }
});

// Cancel upload
router.delete('/:uploadId', authenticate, async (req, res) => {
  try {
    const { uploadId } = req.params;
    const result = await cancelUpload(uploadId, req.user.id);
    res.json(result);
  } catch (error) {
    console.error('Cancel upload error:', error);
    res.status(400).json({ error: error.message });
  }
});

// Get upload status
router.get('/:uploadId/status', authenticate, async (req, res) => {
  try {
    const { uploadId } = req.params;
    const result = await getUploadStatus(uploadId, req.user.id);
    res.json(result);
  } catch (error) {
    console.error('Get upload status error:', error);
    res.status(400).json({ error: error.message });
  }
});

// Get transcoding status
router.get('/:videoId/transcoding', authenticate, async (req, res) => {
  try {
    const { videoId } = req.params;
    const result = await getTranscodingStatus(videoId);

    if (!result) {
      return res.status(404).json({ error: 'Video not found' });
    }

    res.json(result);
  } catch (error) {
    console.error('Get transcoding status error:', error);
    res.status(400).json({ error: error.message });
  }
});

// Simple single-file upload (for smaller files)
router.post('/simple', authenticate, upload.single('video'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No video file provided' });
    }

    const { title, description, categories, tags } = req.body;

    if (!title) {
      return res.status(400).json({ error: 'Title is required' });
    }

    // Initialize upload
    const initResult = await initUpload(
      req.user.id,
      req.file.originalname,
      req.file.size,
      req.file.mimetype
    );

    // Upload as single chunk
    await uploadChunk(initResult.uploadId, 0, req.file.buffer);

    // Complete upload
    const result = await completeUpload(
      initResult.uploadId,
      req.user.id,
      title,
      description,
      categories ? JSON.parse(categories) : [],
      tags ? JSON.parse(tags) : []
    );

    res.json(result);
  } catch (error) {
    console.error('Simple upload error:', error);
    res.status(400).json({ error: error.message });
  }
});

export default router;
