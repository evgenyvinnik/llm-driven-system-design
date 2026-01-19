import { Router, Request, Response } from 'express';
import { authenticateRequest, AuthenticatedRequest } from '../middleware/auth.js';
import {
  getConversations,
  getConversation,
  createDirectConversation,
  createGroupConversation,
  addParticipant,
  removeParticipant,
} from '../services/conversations.js';

const router = Router();

router.use(authenticateRequest as any);

router.get('/', async (req: Request, res: Response): Promise<void> => {
  const authReq = req as AuthenticatedRequest;
  try {
    const conversations = await getConversations(authReq.user.id);
    res.json({ conversations });
  } catch (error) {
    console.error('Get conversations error:', error);
    res.status(500).json({ error: 'Failed to get conversations' });
  }
});

router.get('/:id', async (req: Request, res: Response): Promise<void> => {
  const authReq = req as AuthenticatedRequest;
  try {
    const conversation = await getConversation(req.params.id, authReq.user.id);
    if (!conversation) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }
    res.json({ conversation });
  } catch (error) {
    console.error('Get conversation error:', error);
    res.status(500).json({ error: 'Failed to get conversation' });
  }
});

router.post('/direct', async (req: Request, res: Response): Promise<void> => {
  const authReq = req as AuthenticatedRequest;
  try {
    const { userId } = req.body;

    if (!userId) {
      res.status(400).json({ error: 'User ID is required' });
      return;
    }

    if (userId === authReq.user.id) {
      res.status(400).json({ error: 'Cannot create conversation with yourself' });
      return;
    }

    const conversation = await createDirectConversation(authReq.user.id, userId);
    res.status(201).json({ conversation });
  } catch (error) {
    console.error('Create direct conversation error:', error);
    res.status(500).json({ error: 'Failed to create conversation' });
  }
});

router.post('/group', async (req: Request, res: Response): Promise<void> => {
  const authReq = req as AuthenticatedRequest;
  try {
    const { name, participantIds } = req.body;

    if (!name) {
      res.status(400).json({ error: 'Group name is required' });
      return;
    }

    const conversation = await createGroupConversation(
      authReq.user.id,
      name,
      participantIds || []
    );
    res.status(201).json({ conversation });
  } catch (error) {
    console.error('Create group conversation error:', error);
    res.status(500).json({ error: 'Failed to create group' });
  }
});

router.post('/:id/participants', async (req: Request, res: Response): Promise<void> => {
  const authReq = req as AuthenticatedRequest;
  try {
    const { userId } = req.body;

    if (!userId) {
      res.status(400).json({ error: 'User ID is required' });
      return;
    }

    await addParticipant(req.params.id, userId, authReq.user.id);
    res.json({ message: 'Participant added' });
  } catch (error) {
    console.error('Add participant error:', error);
    if ((error as Error).message.includes('admin')) {
      res.status(403).json({ error: (error as Error).message });
      return;
    }
    res.status(500).json({ error: 'Failed to add participant' });
  }
});

router.delete('/:id/participants/:userId', async (req: Request, res: Response): Promise<void> => {
  const authReq = req as AuthenticatedRequest;
  try {
    await removeParticipant(req.params.id, req.params.userId, authReq.user.id);
    res.json({ message: 'Participant removed' });
  } catch (error) {
    console.error('Remove participant error:', error);
    if ((error as Error).message.includes('admin')) {
      res.status(403).json({ error: (error as Error).message });
      return;
    }
    res.status(500).json({ error: 'Failed to remove participant' });
  }
});

router.delete('/:id/leave', async (req: Request, res: Response): Promise<void> => {
  const authReq = req as AuthenticatedRequest;
  try {
    await removeParticipant(req.params.id, authReq.user.id, authReq.user.id);
    res.json({ message: 'Left conversation' });
  } catch (error) {
    console.error('Leave conversation error:', error);
    res.status(500).json({ error: 'Failed to leave conversation' });
  }
});

export default router;
