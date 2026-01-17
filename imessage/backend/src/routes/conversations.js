import { Router } from 'express';
import { authenticateRequest } from '../middleware/auth.js';
import {
  getConversations,
  getConversation,
  createDirectConversation,
  createGroupConversation,
  addParticipant,
  removeParticipant,
} from '../services/conversations.js';

const router = Router();

router.use(authenticateRequest);

router.get('/', async (req, res) => {
  try {
    const conversations = await getConversations(req.user.id);
    res.json({ conversations });
  } catch (error) {
    console.error('Get conversations error:', error);
    res.status(500).json({ error: 'Failed to get conversations' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const conversation = await getConversation(req.params.id, req.user.id);
    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }
    res.json({ conversation });
  } catch (error) {
    console.error('Get conversation error:', error);
    res.status(500).json({ error: 'Failed to get conversation' });
  }
});

router.post('/direct', async (req, res) => {
  try {
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }

    if (userId === req.user.id) {
      return res.status(400).json({ error: 'Cannot create conversation with yourself' });
    }

    const conversation = await createDirectConversation(req.user.id, userId);
    res.status(201).json({ conversation });
  } catch (error) {
    console.error('Create direct conversation error:', error);
    res.status(500).json({ error: 'Failed to create conversation' });
  }
});

router.post('/group', async (req, res) => {
  try {
    const { name, participantIds } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Group name is required' });
    }

    const conversation = await createGroupConversation(
      req.user.id,
      name,
      participantIds || []
    );
    res.status(201).json({ conversation });
  } catch (error) {
    console.error('Create group conversation error:', error);
    res.status(500).json({ error: 'Failed to create group' });
  }
});

router.post('/:id/participants', async (req, res) => {
  try {
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }

    await addParticipant(req.params.id, userId, req.user.id);
    res.json({ message: 'Participant added' });
  } catch (error) {
    console.error('Add participant error:', error);
    if (error.message.includes('admin')) {
      return res.status(403).json({ error: error.message });
    }
    res.status(500).json({ error: 'Failed to add participant' });
  }
});

router.delete('/:id/participants/:userId', async (req, res) => {
  try {
    await removeParticipant(req.params.id, req.params.userId, req.user.id);
    res.json({ message: 'Participant removed' });
  } catch (error) {
    console.error('Remove participant error:', error);
    if (error.message.includes('admin')) {
      return res.status(403).json({ error: error.message });
    }
    res.status(500).json({ error: 'Failed to remove participant' });
  }
});

router.delete('/:id/leave', async (req, res) => {
  try {
    await removeParticipant(req.params.id, req.user.id, req.user.id);
    res.json({ message: 'Left conversation' });
  } catch (error) {
    console.error('Leave conversation error:', error);
    res.status(500).json({ error: 'Failed to leave conversation' });
  }
});

export default router;
