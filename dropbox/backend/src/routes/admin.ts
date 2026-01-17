import { Router, Response } from 'express';
import { authMiddleware, adminMiddleware, AuthRequest } from '../middleware/auth.js';
import { getAllUsers, updateUserQuota, deleteUser } from '../services/authService.js';
import { query, queryOne } from '../utils/database.js';

const router = Router();

// Apply auth and admin middleware to all routes
router.use(authMiddleware);
router.use(adminMiddleware);

// Get system stats
router.get('/stats', async (req: AuthRequest, res: Response) => {
  try {
    const [userCount] = await query<{ count: string }>('SELECT COUNT(*) as count FROM users');
    const [fileCount] = await query<{ count: string }>(
      'SELECT COUNT(*) as count FROM files WHERE deleted_at IS NULL'
    );
    const [storageStats] = await query<{ total: string }>(
      'SELECT COALESCE(SUM(used_bytes), 0) as total FROM users'
    );
    const [chunkCount] = await query<{ count: string }>('SELECT COUNT(*) as count FROM chunks');
    const [chunkStats] = await query<{ total: string; refs: string }>(
      'SELECT COALESCE(SUM(size), 0) as total, COALESCE(SUM(size * reference_count), 0) as refs FROM chunks'
    );

    const actualStorage = parseInt(chunkStats.total, 10);
    const logicalStorage = parseInt(chunkStats.refs, 10);
    const deduplicationRatio = logicalStorage > 0 ? 1 - actualStorage / logicalStorage : 0;

    res.json({
      totalUsers: parseInt(userCount.count, 10),
      totalFiles: parseInt(fileCount.count, 10),
      totalStorage: parseInt(storageStats.total, 10),
      totalChunks: parseInt(chunkCount.count, 10),
      actualStorageUsed: actualStorage,
      logicalStorageUsed: logicalStorage,
      deduplicationRatio: Math.round(deduplicationRatio * 100) / 100,
      storageSaved: logicalStorage - actualStorage,
    });
  } catch (error) {
    console.error('Get stats error:', error);
    res.status(500).json({ error: (error as Error).message });
  }
});

// Get all users
router.get('/users', async (req: AuthRequest, res: Response) => {
  try {
    const users = await getAllUsers();
    res.json(users);
  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({ error: (error as Error).message });
  }
});

// Get user details with file stats
router.get('/users/:userId', async (req: AuthRequest, res: Response) => {
  try {
    const [user] = await query(
      `SELECT id, email, name, role, quota_bytes as "quotaBytes", used_bytes as "usedBytes",
              created_at as "createdAt", updated_at as "updatedAt"
       FROM users WHERE id = $1`,
      [req.params.userId]
    );

    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const [fileStats] = await query<{ files: string; folders: string }>(
      `SELECT
         COUNT(*) FILTER (WHERE is_folder = false) as files,
         COUNT(*) FILTER (WHERE is_folder = true) as folders
       FROM files WHERE user_id = $1 AND deleted_at IS NULL`,
      [req.params.userId]
    );

    res.json({
      ...user,
      fileCount: parseInt(fileStats.files, 10),
      folderCount: parseInt(fileStats.folders, 10),
    });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: (error as Error).message });
  }
});

// Update user quota
router.patch('/users/:userId/quota', async (req: AuthRequest, res: Response) => {
  try {
    const { quotaBytes } = req.body;

    if (typeof quotaBytes !== 'number' || quotaBytes < 0) {
      res.status(400).json({ error: 'Valid quotaBytes is required' });
      return;
    }

    const user = await updateUserQuota(req.params.userId, quotaBytes);
    res.json(user);
  } catch (error) {
    console.error('Update quota error:', error);
    res.status(400).json({ error: (error as Error).message });
  }
});

// Delete user
router.delete('/users/:userId', async (req: AuthRequest, res: Response) => {
  try {
    // Prevent self-deletion
    if (req.params.userId === req.user!.id) {
      res.status(400).json({ error: 'Cannot delete your own account' });
      return;
    }

    await deleteUser(req.params.userId);
    res.json({ message: 'User deleted' });
  } catch (error) {
    console.error('Delete user error:', error);
    res.status(500).json({ error: (error as Error).message });
  }
});

// Get recent activity
router.get('/activity', async (req: AuthRequest, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string, 10) || 50;

    const activity = await query(
      `SELECT
         f.id,
         f.name,
         f.is_folder as "isFolder",
         f.size,
         f.created_at as "createdAt",
         f.updated_at as "updatedAt",
         u.email as "userEmail",
         u.name as "userName"
       FROM files f
       JOIN users u ON f.user_id = u.id
       ORDER BY f.updated_at DESC
       LIMIT $1`,
      [limit]
    );

    res.json(activity);
  } catch (error) {
    console.error('Get activity error:', error);
    res.status(500).json({ error: (error as Error).message });
  }
});

// Get storage breakdown by file type
router.get('/storage/breakdown', async (req: AuthRequest, res: Response) => {
  try {
    const breakdown = await query(
      `SELECT
         COALESCE(
           CASE
             WHEN mime_type LIKE 'image/%' THEN 'Images'
             WHEN mime_type LIKE 'video/%' THEN 'Videos'
             WHEN mime_type LIKE 'audio/%' THEN 'Audio'
             WHEN mime_type LIKE 'application/pdf' THEN 'PDFs'
             WHEN mime_type LIKE 'application/zip' OR mime_type LIKE 'application/x-rar%' OR mime_type LIKE 'application/x-7z%' THEN 'Archives'
             WHEN mime_type LIKE 'text/%' OR mime_type LIKE 'application/json' OR mime_type LIKE 'application/javascript' THEN 'Text/Code'
             WHEN mime_type LIKE 'application/vnd.ms-%' OR mime_type LIKE 'application/vnd.openxmlformats%' THEN 'Documents'
             ELSE 'Other'
           END, 'Other') as category,
         COUNT(*) as count,
         COALESCE(SUM(size), 0) as "totalSize"
       FROM files
       WHERE deleted_at IS NULL AND is_folder = false
       GROUP BY category
       ORDER BY "totalSize" DESC`
    );

    res.json(breakdown);
  } catch (error) {
    console.error('Get storage breakdown error:', error);
    res.status(500).json({ error: (error as Error).message });
  }
});

// Cleanup orphaned chunks (maintenance)
router.post('/maintenance/cleanup', async (req: AuthRequest, res: Response) => {
  try {
    // Find and delete orphaned chunks (reference_count = 0)
    const orphaned = await query<{ hash: string }>(
      `DELETE FROM chunks WHERE reference_count <= 0 RETURNING hash`
    );

    // Delete from storage
    const { deleteChunk } = await import('../utils/storage.js');
    for (const chunk of orphaned) {
      try {
        await deleteChunk(chunk.hash);
      } catch (e) {
        console.error(`Failed to delete chunk ${chunk.hash}:`, e);
      }
    }

    res.json({
      message: 'Cleanup completed',
      deletedChunks: orphaned.length,
    });
  } catch (error) {
    console.error('Cleanup error:', error);
    res.status(500).json({ error: (error as Error).message });
  }
});

export default router;
