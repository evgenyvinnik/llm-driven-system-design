import { Router, type Request, type Response } from 'express';
import { db } from '../services/database.js';

const router = Router();

// Get all documents
router.get('/documents', async (_req: Request, res: Response) => {
  try {
    const documents = await db.getDocuments();
    res.json(documents);
  } catch (error) {
    console.error('Error fetching documents:', error);
    res.status(500).json({ error: 'Failed to fetch documents' });
  }
});

// Get a single document
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

// Create a new document
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

// Update document title
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

// Get all users
router.get('/users', async (_req: Request, res: Response) => {
  try {
    const users = await db.getUsers();
    res.json(users);
  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// Get a single user
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
