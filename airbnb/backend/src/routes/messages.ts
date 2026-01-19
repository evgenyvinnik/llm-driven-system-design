import { Router, type Request, type Response } from 'express';
import { query } from '../db.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();

// Get or create conversation
router.post('/start', authenticate, async (req, res) => {
  const { listing_id, booking_id } = req.body;

  if (!listing_id) {
    return res.status(400).json({ error: 'listing_id is required' });
  }

  try {
    // Get listing info
    const listingResult = await query(
      'SELECT id, host_id FROM listings WHERE id = $1',
      [listing_id]
    );

    if (listingResult.rows.length === 0) {
      return res.status(404).json({ error: 'Listing not found' });
    }

    const listing = listingResult.rows[0];
    const hostId = listing.host_id;
    const guestId = req.user!.id;

    if (hostId === guestId) {
      return res.status(400).json({ error: 'Cannot message yourself' });
    }

    // Check if conversation exists
    let conversation;
    const existingResult = await query(
      `SELECT * FROM conversations
      WHERE listing_id = $1 AND host_id = $2 AND guest_id = $3`,
      [listing_id, hostId, guestId]
    );

    if (existingResult.rows.length > 0) {
      conversation = existingResult.rows[0];
    } else {
      // Create new conversation
      const createResult = await query(
        `INSERT INTO conversations (listing_id, booking_id, host_id, guest_id)
        VALUES ($1, $2, $3, $4) RETURNING *`,
        [listing_id, booking_id || null, hostId, guestId]
      );
      conversation = createResult.rows[0];
    }

    res.json({ conversation });
  } catch (error) {
    console.error('Start conversation error:', error);
    res.status(500).json({ error: 'Failed to start conversation' });
  }
});

// Get user's conversations
router.get('/', authenticate, async (req, res) => {
  try {
    const result = await query(
      `SELECT c.*,
        l.title as listing_title,
        (SELECT url FROM listing_photos WHERE listing_id = l.id ORDER BY display_order LIMIT 1) as listing_photo,
        h.name as host_name, h.avatar_url as host_avatar,
        g.name as guest_name, g.avatar_url as guest_avatar,
        (SELECT content FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) as last_message,
        (SELECT created_at FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) as last_message_at,
        (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id AND sender_id != $1 AND is_read = FALSE) as unread_count
      FROM conversations c
      LEFT JOIN listings l ON c.listing_id = l.id
      LEFT JOIN users h ON c.host_id = h.id
      LEFT JOIN users g ON c.guest_id = g.id
      WHERE c.host_id = $1 OR c.guest_id = $1
      ORDER BY last_message_at DESC NULLS LAST`,
      [req.user!.id]
    );

    res.json({ conversations: result.rows });
  } catch (error) {
    console.error('Get conversations error:', error);
    res.status(500).json({ error: 'Failed to fetch conversations' });
  }
});

// Get single conversation with messages
router.get('/:id', authenticate, async (req, res) => {
  const { id } = req.params;

  try {
    const convResult = await query(
      `SELECT c.*,
        l.title as listing_title,
        (SELECT url FROM listing_photos WHERE listing_id = l.id ORDER BY display_order LIMIT 1) as listing_photo,
        h.name as host_name, h.avatar_url as host_avatar,
        g.name as guest_name, g.avatar_url as guest_avatar
      FROM conversations c
      LEFT JOIN listings l ON c.listing_id = l.id
      LEFT JOIN users h ON c.host_id = h.id
      LEFT JOIN users g ON c.guest_id = g.id
      WHERE c.id = $1 AND (c.host_id = $2 OR c.guest_id = $2)`,
      [id, req.user!.id]
    );

    if (convResult.rows.length === 0) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    const conversation = convResult.rows[0];

    // Get messages
    const messagesResult = await query(
      `SELECT m.*, u.name as sender_name, u.avatar_url as sender_avatar
      FROM messages m
      LEFT JOIN users u ON m.sender_id = u.id
      WHERE m.conversation_id = $1
      ORDER BY m.created_at ASC`,
      [id]
    );

    // Mark messages as read
    await query(
      `UPDATE messages SET is_read = TRUE
      WHERE conversation_id = $1 AND sender_id != $2 AND is_read = FALSE`,
      [id, req.user!.id]
    );

    res.json({
      conversation,
      messages: messagesResult.rows,
    });
  } catch (error) {
    console.error('Get conversation error:', error);
    res.status(500).json({ error: 'Failed to fetch conversation' });
  }
});

// Send message
router.post('/:id/messages', authenticate, async (req, res) => {
  const { id } = req.params;
  const { content } = req.body;

  if (!content || !content.trim()) {
    return res.status(400).json({ error: 'Message content is required' });
  }

  try {
    // Verify conversation access
    const convResult = await query(
      'SELECT * FROM conversations WHERE id = $1 AND (host_id = $2 OR guest_id = $2)',
      [id, req.user!.id]
    );

    if (convResult.rows.length === 0) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    // Create message
    const result = await query(
      `INSERT INTO messages (conversation_id, sender_id, content)
      VALUES ($1, $2, $3) RETURNING *`,
      [id, req.user!.id, content.trim()]
    );

    // Update conversation timestamp
    await query(
      'UPDATE conversations SET updated_at = NOW() WHERE id = $1',
      [id]
    );

    res.status(201).json({ message: result.rows[0] });
  } catch (error) {
    console.error('Send message error:', error);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// Get unread message count
router.get('/unread/count', authenticate, async (req, res) => {
  try {
    const result = await query(
      `SELECT COUNT(*) as count
      FROM messages m
      JOIN conversations c ON m.conversation_id = c.id
      WHERE (c.host_id = $1 OR c.guest_id = $1)
        AND m.sender_id != $1
        AND m.is_read = FALSE`,
      [req.user!.id]
    );

    res.json({ count: parseInt(result.rows[0].count) });
  } catch (error) {
    console.error('Get unread count error:', error);
    res.status(500).json({ error: 'Failed to get unread count' });
  }
});

export default router;
