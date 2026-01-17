import { Router, type Request, type Response } from 'express';
import { db } from '../services/database.js';

/**
 * REST API router for document and user management.
 *
 * Provides endpoints for:
 * - Document CRUD operations
 * - User listing and retrieval
 *
 * Note: Real-time editing is handled via WebSocket, not REST.
 */
const router = Router();

/**
 * GET /documents
 *
 * List all documents, sorted by last update time.
 *
 * @returns Array of document objects
 */
router.get('/documents', async (_req: Request, res: Response) => {
  try {
    const documents = await db.getDocuments();
    res.json(documents);
  } catch (error) {
    console.error('Error fetching documents:', error);
    res.status(500).json({ error: 'Failed to fetch documents' });
  }
});

/**
 * GET /documents/:id
 *
 * Get a single document by ID.
 *
 * @param id - The document's UUID
 * @returns The document object or 404
 */
router.get('/documents/:id', async (req: Request, res: Response) => {
  try {
    const document = await db.getDocument(req.params.id);
    if (!document) {
      return res.status(404).json({ error: 'Document not found' });
    }
    res.json(document);
  } catch (error) {
    console.error('Error fetching document:', error);
    res.status(500).json({ error: 'Failed to fetch document' });
  }
});

/**
 * POST /documents
 *
 * Create a new document.
 *
 * @body title - Optional document title (defaults to "Untitled Document")
 * @body ownerId - Required user ID of the document creator
 * @returns The created document object
 */
router.post('/documents', async (req: Request, res: Response) => {
  try {
    const { title, ownerId } = req.body;
    if (!ownerId) {
      return res.status(400).json({ error: 'ownerId is required' });
    }
    const document = await db.createDocument(title || 'Untitled Document', ownerId);
    res.status(201).json(document);
  } catch (error) {
    console.error('Error creating document:', error);
    res.status(500).json({ error: 'Failed to create document' });
  }
});

/**
 * PATCH /documents/:id
 *
 * Update a document's title.
 *
 * @param id - The document's UUID
 * @body title - The new title
 * @returns Success confirmation
 */
router.patch('/documents/:id', async (req: Request, res: Response) => {
  try {
    const { title } = req.body;
    if (!title) {
      return res.status(400).json({ error: 'title is required' });
    }
    await db.updateDocumentTitle(req.params.id, title);
    res.json({ success: true });
  } catch (error) {
    console.error('Error updating document:', error);
    res.status(500).json({ error: 'Failed to update document' });
  }
});

/**
 * GET /users
 *
 * List all users in the system.
 *
 * @returns Array of user objects
 */
router.get('/users', async (_req: Request, res: Response) => {
  try {
    const users = await db.getUsers();
    res.json(users);
  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

/**
 * GET /users/:id
 *
 * Get a single user by ID.
 *
 * @param id - The user's UUID
 * @returns The user object or 404
 */
router.get('/users/:id', async (req: Request, res: Response) => {
  try {
    const user = await db.getUser(req.params.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json(user);
  } catch (error) {
    console.error('Error fetching user:', error);
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

export default router;
