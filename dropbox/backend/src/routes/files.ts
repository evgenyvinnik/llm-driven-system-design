/**
 * File and folder management routes.
 * Handles uploads (chunked and simple), downloads, folder operations, versioning.
 * All routes require authentication.
 * @module routes/files
 */

import { Router, Response } from 'express';
import multer from 'multer';
import {
  createUploadSession,
  uploadFileChunk,
  completeUpload,
  createFolder,
  getFolderContents,
  getFile,
  downloadFile,
  renameItem,
  moveItem,
  deleteItem,
  getFileVersions,
  restoreFileVersion,
  getFileChunks,
} from '../services/fileService.js';
import { authMiddleware, AuthRequest } from '../middleware/auth.js';
import { calculateHash, CHUNK_SIZE } from '../utils/chunking.js';
import { getDownloadPresignedUrl } from '../utils/storage.js';

const router = Router();

/** Multer configuration for handling file uploads in memory */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: CHUNK_SIZE * 2, // Allow some overhead
  },
});

// Require authentication for all file routes
router.use(authMiddleware);

/**
 * GET /api/files/folder - Get contents of root folder or specified folder.
 * Query: folderId (optional) - folder to list contents of
 */
router.get('/folder', async (req: AuthRequest, res: Response) => {
  try {
    const folderId = req.query.folderId as string | undefined;
    const contents = await getFolderContents(req.user!.id, folderId || null);
    res.json(contents);
  } catch (error) {
    console.error('Get folder error:', error);
    res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * GET /api/files/folder/:folderId - Get contents of a specific folder.
 */
router.get('/folder/:folderId', async (req: AuthRequest, res: Response) => {
  try {
    const contents = await getFolderContents(req.user!.id, req.params.folderId as string);
    res.json(contents);
  } catch (error) {
    console.error('Get folder error:', error);
    res.status(404).json({ error: (error as Error).message });
  }
});

/**
 * POST /api/files/folder - Create a new folder.
 * Body: { name: string, parentId?: string }
 */
router.post('/folder', async (req: AuthRequest, res: Response) => {
  try {
    const { name, parentId } = req.body;

    if (!name) {
      res.status(400).json({ error: 'Folder name is required' });
      return;
    }

    const folder = await createFolder(req.user!.id, name, parentId || null);
    res.status(201).json(folder);
  } catch (error) {
    console.error('Create folder error:', error);
    res.status(400).json({ error: (error as Error).message });
  }
});

/**
 * POST /api/files/upload/init - Initialize a chunked upload session.
 * Body: { fileName: string, fileSize: number, parentId?: string, chunkHashes: string[] }
 * Returns: { uploadSessionId, chunksNeeded, totalChunks }
 */
router.post('/upload/init', async (req: AuthRequest, res: Response) => {
  try {
    const { fileName, fileSize, parentId, chunkHashes } = req.body;

    if (!fileName || !fileSize || !chunkHashes) {
      res.status(400).json({ error: 'fileName, fileSize, and chunkHashes are required' });
      return;
    }

    // Check quota
    const user = req.user!;
    if (user.usedBytes + fileSize > user.quotaBytes) {
      res.status(400).json({ error: 'Storage quota exceeded' });
      return;
    }

    const session = await createUploadSession(
      user.id,
      fileName,
      fileSize,
      parentId || null,
      chunkHashes
    );

    res.status(201).json(session);
  } catch (error) {
    console.error('Init upload error:', error);
    res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * POST /api/files/upload/chunk - Upload a single chunk.
 * Multipart form: chunk (file), uploadSessionId, chunkIndex, chunkHash
 */
router.post('/upload/chunk', upload.single('chunk'), async (req: AuthRequest, res: Response) => {
  try {
    const { uploadSessionId, chunkIndex, chunkHash } = req.body;

    if (!req.file) {
      res.status(400).json({ error: 'Chunk data is required' });
      return;
    }

    if (!uploadSessionId || chunkIndex === undefined || !chunkHash) {
      res.status(400).json({ error: 'uploadSessionId, chunkIndex, and chunkHash are required' });
      return;
    }

    const result = await uploadFileChunk(
      req.user!.id,
      uploadSessionId,
      parseInt(chunkIndex, 10),
      chunkHash,
      req.file.buffer
    );

    res.json(result);
  } catch (error) {
    console.error('Upload chunk error:', error);
    res.status(400).json({ error: (error as Error).message });
  }
});

/**
 * POST /api/files/upload/complete - Finalize an upload and create the file.
 * Body: { uploadSessionId: string, chunkHashes: string[] }
 */
router.post('/upload/complete', async (req: AuthRequest, res: Response) => {
  try {
    const { uploadSessionId, chunkHashes } = req.body;

    if (!uploadSessionId || !chunkHashes) {
      res.status(400).json({ error: 'uploadSessionId and chunkHashes are required' });
      return;
    }

    const file = await completeUpload(req.user!.id, uploadSessionId, chunkHashes);
    res.json(file);
  } catch (error) {
    console.error('Complete upload error:', error);
    res.status(400).json({ error: (error as Error).message });
  }
});

/**
 * POST /api/files/upload - Simple single-request file upload.
 * For small files - automatically handles chunking, deduplication, and completion.
 * Multipart form: file (required), parentId (optional)
 */
router.post('/upload', upload.single('file'), async (req: AuthRequest, res: Response) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'File is required' });
      return;
    }

    const parentId = req.body.parentId || null;
    const user = req.user!;

    // Check quota
    if (user.usedBytes + req.file.size > user.quotaBytes) {
      res.status(400).json({ error: 'Storage quota exceeded' });
      return;
    }

    // Split file into chunks and calculate hashes
    const chunkSize = CHUNK_SIZE;
    const chunks: Buffer[] = [];
    const chunkHashes: string[] = [];

    let offset = 0;
    while (offset < req.file.buffer.length) {
      const chunk = req.file.buffer.subarray(offset, offset + chunkSize);
      chunks.push(chunk);
      chunkHashes.push(calculateHash(chunk));
      offset += chunkSize;
    }

    // Create upload session
    const session = await createUploadSession(
      user.id,
      req.file.originalname,
      req.file.size,
      parentId,
      chunkHashes
    );

    // Upload chunks that don't exist
    for (let i = 0; i < chunks.length; i++) {
      if (session.chunksNeeded.includes(chunkHashes[i])) {
        await uploadFileChunk(
          user.id,
          session.uploadSessionId,
          i,
          chunkHashes[i],
          chunks[i]
        );
      }
    }

    // Complete upload
    const file = await completeUpload(user.id, session.uploadSessionId, chunkHashes);

    res.status(201).json(file);
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * GET /api/files/file/:fileId - Get file or folder metadata.
 */
router.get('/file/:fileId', async (req: AuthRequest, res: Response) => {
  try {
    const file = await getFile(req.user!.id, req.params.fileId as string);

    if (!file) {
      res.status(404).json({ error: 'File not found' });
      return;
    }

    res.json(file);
  } catch (error) {
    console.error('Get file error:', error);
    res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * GET /api/files/file/:fileId/download - Download a file.
 * Returns file data with appropriate Content-Type and Content-Disposition headers.
 */
router.get('/file/:fileId/download', async (req: AuthRequest, res: Response) => {
  try {
    const { data, file } = await downloadFile(req.user!.id, req.params.fileId as string);

    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.name)}"`);
    res.setHeader('Content-Type', file.mimeType || 'application/octet-stream');
    res.setHeader('Content-Length', data.length);

    res.send(data);
  } catch (error) {
    console.error('Download error:', error);
    res.status(404).json({ error: (error as Error).message });
  }
});

/**
 * GET /api/files/file/:fileId/chunks - Get presigned URLs for parallel chunk download.
 * Returns chunk metadata with presigned S3 URLs for direct download.
 */
router.get('/file/:fileId/chunks', async (req: AuthRequest, res: Response) => {
  try {
    const file = await getFile(req.user!.id, req.params.fileId as string);

    if (!file || file.isFolder) {
      res.status(404).json({ error: 'File not found' });
      return;
    }

    const chunks = await getFileChunks(file.id);
    const downloadUrls = await Promise.all(
      chunks.map(async (chunk) => ({
        index: chunk.chunkIndex,
        hash: chunk.chunkHash,
        size: chunk.chunkSize,
        url: await getDownloadPresignedUrl(chunk.chunkHash),
      }))
    );

    res.json({ file, chunks: downloadUrls });
  } catch (error) {
    console.error('Get chunks error:', error);
    res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * PATCH /api/files/file/:fileId/rename - Rename a file or folder.
 * Body: { name: string }
 */
router.patch('/file/:fileId/rename', async (req: AuthRequest, res: Response) => {
  try {
    const { name } = req.body;

    if (!name) {
      res.status(400).json({ error: 'Name is required' });
      return;
    }

    const file = await renameItem(req.user!.id, req.params.fileId as string, name);
    res.json(file);
  } catch (error) {
    console.error('Rename error:', error);
    res.status(400).json({ error: (error as Error).message });
  }
});

/**
 * PATCH /api/files/file/:fileId/move - Move a file or folder.
 * Body: { parentId: string | null }
 */
router.patch('/file/:fileId/move', async (req: AuthRequest, res: Response) => {
  try {
    const { parentId } = req.body;

    const file = await moveItem(req.user!.id, req.params.fileId as string, parentId || null);
    res.json(file);
  } catch (error) {
    console.error('Move error:', error);
    res.status(400).json({ error: (error as Error).message });
  }
});

/**
 * DELETE /api/files/file/:fileId - Soft delete a file or folder.
 */
router.delete('/file/:fileId', async (req: AuthRequest, res: Response) => {
  try {
    await deleteItem(req.user!.id, req.params.fileId as string);
    res.json({ message: 'Deleted successfully' });
  } catch (error) {
    console.error('Delete error:', error);
    res.status(400).json({ error: (error as Error).message });
  }
});

/**
 * GET /api/files/file/:fileId/versions - Get version history for a file.
 */
router.get('/file/:fileId/versions', async (req: AuthRequest, res: Response) => {
  try {
    const versions = await getFileVersions(req.user!.id, req.params.fileId as string);
    res.json(versions);
  } catch (error) {
    console.error('Get versions error:', error);
    res.status(400).json({ error: (error as Error).message });
  }
});

/**
 * POST /api/files/file/:fileId/versions/:versionId/restore - Restore a previous version.
 */
router.post('/file/:fileId/versions/:versionId/restore', async (req: AuthRequest, res: Response) => {
  try {
    const file = await restoreFileVersion(
      req.user!.id,
      req.params.fileId as string,
      req.params.versionId as string
    );
    res.json(file);
  } catch (error) {
    console.error('Restore version error:', error);
    res.status(400).json({ error: (error as Error).message });
  }
});

export default router;
